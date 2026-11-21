'use strict'
/**
 * integration.test.js — 実HTTPサーバー相手の結合テスト
 *
 * DeepSeek / VOICEVOX のモックサーバーを 127.0.0.1 に立て、
 * モックfetchではなく実際の fetch（undici）でクライアントを検証する。
 * これにより「実際のHTTP通信・JSON・SSE解析」が通ることを確認する
 * （本物のAPIキー / 本物のVOICEVOX本体を使う確認とは別）。
 */
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { createDeepSeekClient } = require('../src/core/deepseek')
const { createVoicevoxClient } = require('../src/core/voicevox')

let server
let base

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        assert.strictEqual(req.headers.authorization, 'Bearer sk-integration')
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(
            'data: {"choices":[{"delta":{"content":"[happy]通"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"信OK"}}]}\n\n' +
              'data: [DONE]\n\n'
          )
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: '応答です' } }] }))
        }
      })
      return
    }
    if (url.pathname === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('"0.25.0"')
      return
    }
    if (url.pathname === '/audio_query') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ speedScale: 1, pitchScale: 0, intonationScale: 1 }))
      return
    }
    if (url.pathname === '/synthesis') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(Buffer.from('RIFF-FAKE-WAV'))
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

test('DeepSeekクライアントが実HTTPで非ストリーミング応答を受ける', async () => {
  const client = createDeepSeekClient({ apiKey: 'sk-integration', baseUrl: base })
  const r = await client.chat([{ role: 'user', content: 'hi' }])
  assert.strictEqual(r.content, '応答です')
})

test('DeepSeekクライアントが実HTTPでSSEストリーミングを受ける', async () => {
  const client = createDeepSeekClient({ apiKey: 'sk-integration', baseUrl: base })
  const got = []
  const r = await client.chatStream([{ role: 'user', content: 'hi' }], {}, (d) => got.push(d))
  assert.strictEqual(r.content, '[happy]通信OK')
  assert.deepStrictEqual(got, ['[happy]通', '信OK'])
})

test('VOICEVOXクライアントが実HTTPで wav を受ける', async () => {
  const vv = createVoicevoxClient({ baseUrl: base })
  assert.strictEqual(await vv.isAvailable(), true)
  const wav = await vv.synthesize('テスト', { speaker: 8 })
  assert.strictEqual(Buffer.from(wav).toString(), 'RIFF-FAKE-WAV')
})
