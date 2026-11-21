'use strict'
/**
 * qwen-tts.js — Qwen3-TTS クライアント（中国語なまりの日本語 用）
 *
 * 狙い: tegnike の動画（クレジット: AI voice Qwen3-TTS）の再現。
 * Qwen3-TTS CustomVoice には中国語ネイティブ話者（Vivian / Serena 等）がおり、
 * language='Japanese' + speaker='Vivian' のように「中国語話者に日本語テキストを読ませる」と、
 * 声質と発音の癖が中国語寄りになり、中国語なまりの日本語になる。これが本モジュールの既定設定。
 * （公式ドキュメントは「話者の母語での利用を推奨」としているが、多言語合成自体は対応言語間で可能。
 *   なまりの強さは話者・モデル・文によって変わるため、実音声での最終確認が必要。）
 *
 * 接続方式は2つ:
 *  A) local: ローカルで動く Qwen3-TTS サーバー（scripts/qwen-tts-server.py、同梱）
 *     POST {serverUrl}/synthesize { text, speaker, language, instruct } -> audio/wav
 *     GET  {serverUrl}/health / /speakers
 *  B) cloud: Alibaba Cloud Model Studio (DashScope) の Qwen3-TTS
 *     POST {cloudBaseUrl}/api/v1/services/aigc/multimodal-generation/generation
 *     APIキーは環境変数 DASHSCOPE_API_KEY からのみ。コードに埋め込まない。
 *     ※ クラウドの正確なレスポンス形式は提供側の更新があり得るため、url / base64 の両形式に対応している。
 */

const SPEAKERS = [
  { id: 'Vivian', native: 'Chinese', label: 'Vivian（中国語・明るい若い女性）' },
  { id: 'Serena', native: 'Chinese', label: 'Serena（中国語・温かく柔らかい若い女性）' },
  { id: 'Uncle_Fu', native: 'Chinese', label: 'Uncle_Fu（中国語・落ち着いた男性）' },
  { id: 'Dylan', native: 'Chinese', label: 'Dylan（中国語・北京の若い男性）' },
  { id: 'Eric', native: 'Chinese', label: 'Eric（中国語・男性）' },
  { id: 'Ryan', native: 'English', label: 'Ryan（英語・男性）' },
  { id: 'Aiden', native: 'English', label: 'Aiden（英語・男性）' },
  { id: 'Ono_Anna', native: 'Japanese', label: 'Ono_Anna（日本語・元気な女性／なまり無し）' },
  { id: 'Sohee', native: 'Korean', label: 'Sohee（韓国語・女性）' },
]

const DEFAULTS = {
  mode: 'local', // 'local' | 'cloud'
  serverUrl: 'http://127.0.0.1:8765',
  cloudBaseUrl: 'https://dashscope.aliyuncs.com',
  model: 'qwen3-tts-flash',
  speaker: 'Vivian',
  language: 'Japanese',
  instruct: '',
}

class QwenTtsError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'QwenTtsError'
    this.status = status || 0
  }
}

function createQwenTtsClient(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const fetchImpl = cfg.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new QwenTtsError('fetch が利用できません')
  const serverUrl = String(cfg.serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, '')
  const cloudBaseUrl = String(cfg.cloudBaseUrl || DEFAULTS.cloudBaseUrl).replace(/\/+$/, '')

  async function isAvailable() {
    if (cfg.mode === 'cloud') return Boolean(cfg.apiKey)
    return (await status()).available
  }

  async function status() {
    if (cfg.mode === 'cloud') return { available: Boolean(cfg.apiKey), status: cfg.apiKey ? 'ready' : 'missing-key' }
    try {
      const res = await fetchImpl(`${serverUrl}/health`, { signal: AbortSignal.timeout(2500) })
      const info = await res.json()
      return { available: res.ok && info.ok === true, status: info.status || (res.ok ? 'ready' : 'error'), error: info.error }
    } catch {
      return { available: false, status: 'offline' }
    }
  }

  /** ローカルサーバーが /speakers を持てばそれを、無ければ静的な話者一覧を返す */
  async function speakers() {
    if (cfg.mode === 'local') {
      try {
        const res = await fetchImpl(`${serverUrl}/speakers`)
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data) && data.length) return data
        }
      } catch {
        /* 静的一覧にフォールバック */
      }
    }
    return SPEAKERS
  }

  async function synthesizeLocal(text, opts) {
    const res = await fetchImpl(`${serverUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        text,
        speaker: opts.speaker || cfg.speaker,
        language: opts.language || cfg.language,
        instruct: opts.instruct ?? cfg.instruct,
        speed: opts.speed ?? 1,
        pitch: opts.pitch ?? 0,
      }),
    })
    if (!res.ok) {
      let detail = ''; try { detail = (await res.json()).error || '' } catch {}
      throw new QwenTtsError(`Qwen3-TTS (${res.status}) ${detail}`, res.status)
    }
    const ct = res.headers?.get?.('content-type') || ''
    if (ct.includes('application/json')) {
      const data = await res.json()
      const buf = await audioFromPayload(data, fetchImpl)
      if (buf) return buf
      throw new QwenTtsError('Qwen3-TTS サーバーの応答に音声が含まれていませんでした')
    }
    return res.arrayBuffer()
  }

  async function synthesizeCloud(text, opts) {
    if (!cfg.apiKey) {
      throw new QwenTtsError(
        'DASHSCOPE_API_KEY が設定されていません。設定画面で DashScope APIキーを入力するか、ローカルモードを使ってください。',
        0
      )
    }
    const body = {
      model: cfg.model,
      input: {
        text,
        voice: opts.speaker || cfg.speaker,
        language_type: opts.language || cfg.language,
      },
    }
    const instruct = opts.instruct ?? cfg.instruct
    if (instruct) body.input.instructions = instruct
    const res = await fetchImpl(`${cloudBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {}
      throw new QwenTtsError(`DashScope Qwen3-TTS エラー (${res.status}) ${detail.slice(0, 200)}`, res.status)
    }
    const data = await res.json()
    const buf = await audioFromPayload(data?.output || data, fetchImpl)
    if (!buf) throw new QwenTtsError('DashScope の応答に音声が含まれていませんでした')
    return buf
  }

  async function synthesize(text, opts = {}) {
    const t = String(text || '').trim()
    if (!t) throw new QwenTtsError('空のテキストは合成できません')
    return cfg.mode === 'cloud' ? synthesizeCloud(t, opts) : synthesizeLocal(t, opts)
  }

  return { isAvailable, status, speakers, synthesize, mode: cfg.mode, defaults: { ...cfg, apiKey: undefined } }
}

/** { audio: { url } } / { audio: { data: base64 } } / { audio_url } 等から音声バイト列を取り出す */
async function audioFromPayload(payload, fetchImpl) {
  if (!payload || typeof payload !== 'object') return null
  const audio = payload.audio || payload
  const url = audio.url || audio.audio_url || payload.audio_url
  if (url) {
    const res = await fetchImpl(url)
    if (!res.ok) throw new QwenTtsError(`音声ファイルの取得に失敗しました (${res.status})`, res.status)
    return res.arrayBuffer()
  }
  const b64 = audio.data || audio.base64 || payload.data
  if (b64 && typeof b64 === 'string') {
    const buf = Buffer.from(b64, 'base64')
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  return null
}

module.exports = { SPEAKERS, DEFAULTS, QwenTtsError, createQwenTtsClient, audioFromPayload }
