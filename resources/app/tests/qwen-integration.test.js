'use strict'
/**
 * qwen-integration.test.js — Qwen3-TTS ローカルサーバー形式との実HTTP結合テスト
 * 同梱サーバー（scripts/qwen-tts-server.py）と同じ API 形式のモックを立て、
 * 実際の fetch でクライアントを検証する（実モデルでの発声確認とは別）。
 */
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { createQwenTtsClient } = require('../src/core/qwen-tts')

let server
let base
let lastBody = null

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, model: 'mock' }))
      return
    }
    if (req.url === '/speakers') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ id: 'Vivian', label: 'Vivian（mock）' }]))
      return
    }
    if (req.url === '/synthesize' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        lastBody = JSON.parse(body)
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(Buffer.from('RIFF-QWEN-MOCK'))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

test('実HTTPで health / speakers / synthesize が通る', async () => {
  const c = createQwenTtsClient({ serverUrl: base })
  assert.strictEqual(await c.isAvailable(), true)
  const speakers = await c.speakers()
  assert.strictEqual(speakers[0].id, 'Vivian')
  const wav = await c.synthesize('青いロングヘアが私のトレードマークです。')
  assert.strictEqual(Buffer.from(wav).toString(), 'RIFF-QWEN-MOCK')
  assert.strictEqual(lastBody.speaker, 'Vivian')
  assert.strictEqual(lastBody.language, 'Japanese')
})
