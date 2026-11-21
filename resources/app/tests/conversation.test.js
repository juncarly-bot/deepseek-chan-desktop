'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Conversation } = require('../src/core/conversation')
const { HistoryStore } = require('../src/core/history')
const { loadSettings } = require('../src/core/config')

function fakeDeepSeek(reply) {
  return {
    async chatStream(messages, opts, onToken) {
      // システムプロンプトと履歴が渡ってきていることを確認
      assert.strictEqual(messages[0].role, 'system')
      assert.ok(messages[0].content.includes('DeepSeekちゃん'))
      assert.strictEqual(messages[messages.length - 1].content, 'おはよう')
      onToken(reply)
      return { content: reply }
    },
  }
}

test('会話1往復: ストリーミング→タグ解析→履歴保存まで通る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-conv-'))
  const history = new HistoryStore(path.join(dir, 'h.json'))
  history.load()
  const settings = loadSettings(path.join(dir, 's.json'))
  const conv = new Conversation({ deepseek: fakeDeepSeek('[happy][motion:wave]おはよう！'), history, settings })
  const events = []
  conv.onEvent((type) => events.push(type))
  const tokens = []
  const r = await conv.send('おはよう', { onToken: (d) => tokens.push(d) })
  assert.strictEqual(r.plainText, 'おはよう！')
  assert.strictEqual(r.segments[0].emotion, 'happy')
  assert.strictEqual(r.segments[0].motion, 'wave')
  assert.deepStrictEqual(tokens, ['[happy][motion:wave]おはよう！'])
  assert.strictEqual(history.list().length, 2)
  assert.strictEqual(history.list()[1].emotion, 'happy')
  assert.deepStrictEqual(events, ['messageReceived', 'replySent'])
})

test('音声簡潔モードでも回答全文を1回の会話で保存し再読み込みする', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-adaptive-history-'))
  const file = path.join(dir, 'h.json')
  const history = new HistoryStore(file)
  const settings = loadSettings(path.join(dir, 's.json'))
  settings.features.adaptiveVoiceResponse = true
  let calls = 0
  const reply = '[thinking]まず対称性を確認しよう。次にガウスの法則を使って導出するよ。'
  const conv = new Conversation({ history, settings, deepseek: { async chatStream(_m, _o, onToken) {
    calls++
    for (const char of reply) onToken(char)
    return { content:reply }
  } } })
  const result = await conv.send('物理の質問')
  const restored = new HistoryStore(file)
  restored.load()
  assert.strictEqual(calls, 1)
  assert.strictEqual(restored.list()[1].content, result.plainText)
  assert.strictEqual(result.plainText, 'まず対称性を確認しよう。次にガウスの法則を使って導出するよ。')
})

test('空メッセージはエラー', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-conv-'))
  const conv = new Conversation({
    deepseek: fakeDeepSeek('x'),
    history: new HistoryStore(path.join(dir, 'h.json')),
    settings: loadSettings(path.join(dir, 's.json')),
  })
  await assert.rejects(() => conv.send('  '), /空のメッセージ/)
})

test('会話のAbortSignalをDeepSeekへ渡し、割り込まれた返答を履歴へ保存しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-conv-abort-'))
  const history = new HistoryStore(path.join(dir, 'h.json'))
  const controller = new AbortController()
  const conv = new Conversation({
    deepseek: {
      chatStream(_messages, opts) {
        assert.strictEqual(opts.signal, controller.signal)
        return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true }))
      },
    },
    history,
    settings: loadSettings(path.join(dir, 's.json')),
  })
  const pending = conv.send('割り込みテスト', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.deepStrictEqual(history.list().map(row => row.role), ['user'])
})

test('generateIdleLine は独り言を生成し履歴に残さない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-conv-'))
  const history = new HistoryStore(path.join(dir, 'h.json'))
  const deepseek = {
    async chat(messages) {
      assert.ok(messages[messages.length - 1].content.includes('システム指示'))
      return { content: '[relaxed]いい天気だね' }
    },
  }
  const conv = new Conversation({ deepseek, history, settings: loadSettings(path.join(dir, 's.json')) })
  const r = await conv.generateIdleLine()
  assert.strictEqual(r.plainText, 'いい天気だね')
  assert.strictEqual(history.list().length, 0)
})

test('generateIdleLine はAbortSignalをDeepSeekへ渡す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-idle-abort-'))
  const controller = new AbortController()
  const conv = new Conversation({
    deepseek: { async chat(_messages, opts) {
      assert.strictEqual(opts.signal, controller.signal)
      return { content:'[neutral]短い独り言。' }
    } },
    history:new HistoryStore(path.join(dir, 'h.json')),
    settings:loadSettings(path.join(dir, 's.json')),
  })
  const line = await conv.generateIdleLine(undefined, { signal:controller.signal })
  assert.equal(line.plainText, '短い独り言。')
  assert.deepStrictEqual(conv.history.list(), [])
})
