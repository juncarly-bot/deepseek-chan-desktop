const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQwenTtsClient } = require('../src/core/qwen-tts')

test('ロード中のサーバーを接続済みと表示しない', async () => {
  const client = createQwenTtsClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }) })
  assert.equal(await client.isAvailable(), false)
})

test('ローカルQwenに話速と半音ピッチを渡す', async () => {
  let body
  const client = createQwenTtsClient({ fetchImpl: async (_url, opts) => {
    body = JSON.parse(opts.body)
    return { ok: true, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => new ArrayBuffer(2) }
  } })
  await client.synthesize('テスト', { speed: 1.05, pitch: 0.5 })
  assert.equal(body.speed, 1.05)
  assert.equal(body.pitch, 0.5)
})

test('モデル準備中の理由を表示用エラーに保持する', async () => {
  const client = createQwenTtsClient({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'モデルを準備中' }) }) })
  await assert.rejects(client.synthesize('テスト'), /モデルを準備中/)
})
