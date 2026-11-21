'use strict'
/**
 * deepseek.js — DeepSeek API クライアント（OpenAI 互換）
 *
 * - エンドポイント: POST {baseUrl}/chat/completions（既定 https://api.deepseek.com）
 * - モデル: deepseek-flash（既定）/ deepseek-v4-pro
 * - APIキーは引数（環境変数 DEEPSEEK_API_KEY）からのみ受け取る。コードに埋め込まない。
 * - ストリーミング（SSE）対応。fetchImpl を差し替え可能にしてテストできるようにしている。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const MODELS = ['deepseek-flash', 'deepseek-v4-pro']

function normalizeModel(model) {
  if (model === 'deepseek-chat' || model === 'deepseek-reasoner') return 'deepseek-flash'
  return model || DEFAULT_MODEL
}

class DeepSeekError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'DeepSeekError'
    this.status = status || 0
    this.body = body || ''
  }
}

/** HTTP ステータスからユーザー向けの対処ヒントを返す */
function hintForStatus(status) {
  switch (status) {
    case 401:
      return 'APIキーが無効です（仮キーや期限切れのキーでは認証できません）。設定画面で正しいキーを入力してください。'
    case 402:
      return 'DeepSeek 側の残高不足です。platform.deepseek.com でチャージ状況を確認してください。'
    case 429:
      return 'リクエストが集中しています。少し待ってから再送してください。'
    case 500:
    case 502:
    case 503:
      return 'DeepSeek 側のサーバーエラーです。少し待ってから再送してください。'
    default:
      return ''
  }
}

function errorFromResponse(status, bodyText) {
  const hint = hintForStatus(status)
  return new DeepSeekError(`DeepSeek API エラー (${status})${hint ? `: ${hint}` : ''}`, status, bodyText)
}

/** SSE の1チャンク（複数行でも可）から delta 文字列を取り出す。テスト用に公開。 */
function parseSSEChunk(chunk) {
  const tokens = []
  let done = false
  for (const line of String(chunk).split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      continue
    }
    try {
      const json = JSON.parse(data)
      const delta =
        json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? ''
      if (delta) tokens.push(delta)
    } catch {
      /* 不完全な JSON 行は次のチャンクで結合される前提で無視 */
    }
  }
  return { tokens, done }
}

function createDeepSeekClient(options = {}) {
  const apiKey = options.apiKey || ''
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = normalizeModel(options.model)
  const thinkingMode = options.thinkingMode === 'enabled' ||
    (options.thinkingMode === undefined && options.model === 'deepseek-reasoner') ? 'enabled' : 'disabled'
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new DeepSeekError('fetch が利用できません（Node 18+ / Electron が必要です）')
  }

  function assertKey() {
    if (!apiKey) {
      throw new DeepSeekError(
        'DEEPSEEK_API_KEY が設定されていません。.env にキーを書くか、設定画面で入力してください。',
        0,
        'missing_api_key'
      )
    }
  }

  async function request(body, options = {}) {
    assertKey()
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify(body),
    })
    return res
  }

  /** 非ストリーミング会話。messages は [{role, content}] */
  async function chat(messages, opts = {}) {
    const body = {
      model: normalizeModel(opts.model || model),
      messages,
      stream: false,
      thinking: { type: opts.thinkingMode === 'enabled' ? 'enabled' : (opts.thinkingMode === 'disabled' ? 'disabled' : thinkingMode) },
    }
    // Thinking mode ignores temperature; retain the old non-thinking chat default.
    if (body.thinking.type === 'disabled' && typeof opts.temperature === 'number') body.temperature = opts.temperature
    if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens
    const res = await request(body, { signal: opts.signal })
    if (!res.ok) {
      const text = await safeText(res)
      throw errorFromResponse(res.status, text)
    }
    const json = await res.json()
    const content = json.choices?.[0]?.message?.content ?? ''
    return { content, usage: json.usage || null, model: json.model || body.model, raw: json }
  }

  /**
   * ストリーミング会話。トークンを onToken(delta) に逐次渡し、全文を返す。
   * res.body が Web ReadableStream でも Node stream でも動くよう両対応。
   */
  async function chatStream(messages, opts = {}, onToken) {
    const body = {
      model: normalizeModel(opts.model || model),
      messages,
      stream: true,
      thinking: { type: opts.thinkingMode === 'enabled' ? 'enabled' : (opts.thinkingMode === 'disabled' ? 'disabled' : thinkingMode) },
    }
    if (body.thinking.type === 'disabled' && typeof opts.temperature === 'number') body.temperature = opts.temperature
    if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens
    const res = await request(body, { signal: opts.signal })
    if (!res.ok) {
      const text = await safeText(res)
      throw errorFromResponse(res.status, text)
    }
    let full = ''
    const emit = (chunkStr) => {
      const { tokens } = parseSSEChunk(chunkStr)
      for (const tok of tokens) {
        full += tok
        if (typeof onToken === 'function') onToken(tok)
      }
    }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      const abortReader = () => { reader.cancel().catch(() => {}) }
      opts.signal?.addEventListener('abort', abortReader, { once: true })
      try {
        for (;;) {
          if (opts.signal?.aborted) throw abortError()
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split(/\r?\n\r?\n/)
          buffer = parts.pop() || ''
          for (const p of parts) emit(p)
        }
      } catch (error) {
        if (opts.signal?.aborted) {
          try { await reader.cancel() } catch {}
          throw abortError()
        }
        throw error
      } finally {
        opts.signal?.removeEventListener('abort', abortReader)
      }
      if (opts.signal?.aborted) throw abortError()
      if (buffer) emit(buffer)
    } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      for await (const chunk of res.body) {
        if (opts.signal?.aborted) throw abortError()
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        const parts = buffer.split(/\r?\n\r?\n/)
        buffer = parts.pop() || ''
        for (const p of parts) emit(p)
      }
      if (buffer) emit(buffer)
    } else {
      // ストリームが取れない環境では全文を1回で返す
      const text = await safeText(res)
      emit(text)
    }
    return { content: full, model: body.model }
  }

  return { chat, chatStream, model, baseUrl, hasKey: () => Boolean(apiKey) }
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MODELS,
  normalizeModel,
  DeepSeekError,
  hintForStatus,
  errorFromResponse,
  parseSSEChunk,
  createDeepSeekClient,
}
