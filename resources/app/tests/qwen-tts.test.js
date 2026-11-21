'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createQwenTtsClient, SPEAKERS, QwenTtsError } = require('../src/core/qwen-tts')

test('話者一覧に中国語ネイティブ話者が含まれ、既定は Vivian', () => {
  const zh = SPEAKERS.filter((s) => s.native === 'Chinese').map((s) => s.id)
  assert.deepStrictEqual(zh, ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric'])
  const c = createQwenTtsClient({ fetchImpl: async () => ({ ok: true }) })
  assert.strictEqual(c.defaults.speaker, 'Vivian')
  assert.strictEqual(c.defaults.language, 'Japanese')
})

test('ローカル方式: /health で接続判定、/synthesize に speaker と language を送る', async () => {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    if (String(url).endsWith('/health')) return { ok: true, json: async () => ({ ok: true }) }
    if (String(url).endsWith('/synthesize')) {
      return {
        ok: true,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => new TextEncoder().encode('QWENWAV').buffer,
      }
    }
    return { ok: false, status: 404 }
  }
  const c = createQwenTtsClient({ fetchImpl, serverUrl: 'http://127.0.0.1:8765' })
  assert.strictEqual(await c.isAvailable(), true)
  const wav = await c.synthesize('こんにちは、わたしはDeepSeekちゃんです。')
  assert.strictEqual(new TextDecoder().decode(wav), 'QWENWAV')
  const body = JSON.parse(calls[1].opts.body)
  assert.strictEqual(body.speaker, 'Vivian') // 中国語話者
  assert.strictEqual(body.language, 'Japanese') // 日本語テキストを読む = 中国語なまりの狙い
  assert.strictEqual(body.text, 'こんにちは、わたしはDeepSeekちゃんです。')
})

test('ローカル方式: サーバー停止中は isAvailable=false、合成はエラー', async () => {
  const c = createQwenTtsClient({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.strictEqual(await c.isAvailable(), false)
  await assert.rejects(() => c.synthesize('テスト'), /ECONNREFUSED/)
})

test('クラウド方式: キー未設定なら合成前に分かりやすいエラー', async () => {
  const c = createQwenTtsClient({ mode: 'cloud', fetchImpl: async () => ({ ok: true }) })
  assert.strictEqual(await c.isAvailable(), false)
  await assert.rejects(() => c.synthesize('テスト'), /DASHSCOPE_API_KEY/)
})

test('クラウド方式: DashScope に送り、返ってきた audio.url を取得する', async () => {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    if (String(url).includes('multimodal-generation')) {
      return {
        ok: true,
        json: async () => ({ output: { audio: { url: 'https://example.invalid/out.wav' } } }),
      }
    }
    if (String(url) === 'https://example.invalid/out.wav') {
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('CLOUDWAV').buffer }
    }
    return { ok: false, status: 404 }
  }
  const c = createQwenTtsClient({ mode: 'cloud', apiKey: 'ds-test', fetchImpl })
  assert.strictEqual(await c.isAvailable(), true)
  const wav = await c.synthesize('你好ではなく日本語の文', { speaker: 'Serena' })
  assert.strictEqual(new TextDecoder().decode(wav), 'CLOUDWAV')
  const body = JSON.parse(calls[0].opts.body)
  assert.strictEqual(body.model, 'qwen3-tts-flash')
  assert.strictEqual(body.input.voice, 'Serena')
  assert.strictEqual(body.input.language_type, 'Japanese')
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer ds-test')
})

test('クラウド方式: base64 で返る形式にも対応する', async () => {
  const b64 = Buffer.from('B64WAV').toString('base64')
  const fetchImpl = async () => ({ ok: true, json: async () => ({ output: { audio: { data: b64 } } }) })
  const c = createQwenTtsClient({ mode: 'cloud', apiKey: 'ds-test', fetchImpl })
  const wav = await c.synthesize('テスト')
  assert.strictEqual(Buffer.from(wav).toString(), 'B64WAV')
})

test('空テキストはエラー', async () => {
  const c = createQwenTtsClient({ fetchImpl: async () => ({ ok: true }) })
  await assert.rejects(() => c.synthesize('  '), QwenTtsError)
})
