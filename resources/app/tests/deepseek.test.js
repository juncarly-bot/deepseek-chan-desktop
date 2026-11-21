'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createDeepSeekClient, parseSSEChunk, DeepSeekError } = require('../src/core/deepseek')

test('parseSSEChunk は delta を取り出す', () => {
  const chunk =
    'data: {"choices":[{"delta":{"content":"こん"}}]}\n' +
    'data: {"choices":[{"delta":{"content":"にちは"}}]}\n' +
    'data: [DONE]\n'
  const { tokens, done } = parseSSEChunk(chunk)
  assert.deepStrictEqual(tokens, ['こん', 'にちは'])
  assert.strictEqual(done, true)
})

test('APIキー未設定では送信前にエラーになる', async () => {
  const client = createDeepSeekClient({ apiKey: '', fetchImpl: async () => { throw new Error('呼ばれないはず') } })
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /DEEPSEEK_API_KEY/)
})

test('非ストリーミング会話がモックAPIで動く（URL・認証ヘッダ・モデルを確認）', async () => {
  let seen = null
  const fetchImpl = async (url, opts) => {
    seen = { url, opts }
    return {
      ok: true,
      json: async () => ({
        model: 'deepseek-flash',
        choices: [{ message: { content: '[happy]やっほー！' } }],
        usage: { total_tokens: 10 },
      }),
    }
  }
  const client = createDeepSeekClient({ apiKey: 'sk-test', fetchImpl })
  const r = await client.chat([{ role: 'user', content: 'あいさつして' }])
  assert.strictEqual(r.content, '[happy]やっほー！')
  assert.strictEqual(seen.url, 'https://api.deepseek.com/chat/completions')
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer sk-test')
  assert.strictEqual(JSON.parse(seen.opts.body).model, 'deepseek-flash')
  assert.deepStrictEqual(JSON.parse(seen.opts.body).thinking, { type: 'disabled' })
})

test('旧モデルIDはFlashへ移行し、旧reasonerは推論モードを維持する', async () => {
  let bodies = []
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  const client = createDeepSeekClient({ apiKey: 'sk-test', model: 'deepseek-reasoner', fetchImpl })
  await client.chat([{ role: 'user', content: 'x' }])
  assert.equal(bodies[0].model, 'deepseek-flash')
  assert.deepStrictEqual(bodies[0].thinking, { type: 'enabled' })
})

test('ストリーミング会話が SSE を逐次返し全文を組み立てる', async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"[neutral]テスト"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"です。"}}]}\r\n\r\n' +
    'data: [DONE]\r\n\r\n'
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse))
      c.close()
    },
  })
  const fetchImpl = async () => ({ ok: true, body: stream })
  const client = createDeepSeekClient({ apiKey: 'sk-test', fetchImpl })
  const got = []
  const r = await client.chatStream([{ role: 'user', content: 'x' }], {}, (d) => got.push(d))
  assert.strictEqual(r.content, '[neutral]テストです。')
  assert.deepStrictEqual(got, ['[neutral]テスト', 'です。'])
})

test('AbortSignalで未完了のDeepSeek SSE読み込みを停止する', async () => {
  const controller = new AbortController()
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  let requestSignal = null
  const client = createDeepSeekClient({
    apiKey: 'sk-test',
    fetchImpl: async (_url, options) => { requestSignal = options.signal; return { ok: true, body } },
  })
  const pending = client.chatStream([{ role: 'user', content: 'x' }], { signal: controller.signal }, () => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.strictEqual(requestSignal, controller.signal)
  assert.strictEqual(cancelled, true)
})

test('APIエラーは DeepSeekError（status付き）になる', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
  const client = createDeepSeekClient({ apiKey: 'sk-bad', fetchImpl })
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (e) => e instanceof DeepSeekError && e.status === 401
  )
})
