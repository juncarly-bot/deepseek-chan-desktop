'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { HistoryStore } = require('../src/core/history')

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-history-'))
  return path.join(dir, 'chat-history.json')
}

test('追加・保存・再読み込み・検索・削除ができる', () => {
  const file = tmpFile()
  const h = new HistoryStore(file)
  h.load()
  h.add('user', 'おはよう')
  h.add('assistant', 'おはよう！今日もがんばろうね', { emotion: 'happy' })
  h.add('user', '昨日の続きだけど、猫の話したよね')
  assert.strictEqual(h.list().length, 3)
  assert.ok(fs.existsSync(file))

  const h2 = new HistoryStore(file)
  h2.load()
  assert.strictEqual(h2.list().length, 3)
  assert.strictEqual(h2.list()[1].emotion, 'happy')

  assert.strictEqual(h2.search('猫').length, 1)
  assert.strictEqual(h2.search('存在しない').length, 0)

  h2.clear()
  assert.strictEqual(h2.list().length, 0)
})

test('buildMessages は system + 直近ターンだけを返す', () => {
  const h = new HistoryStore(tmpFile())
  for (let i = 0; i < 10; i++) {
    h.add('user', `質問${i}`)
    h.add('assistant', `回答${i}`)
  }
  const msgs = h.buildMessages('SYS', 2)
  assert.strictEqual(msgs[0].role, 'system')
  assert.strictEqual(msgs.length, 1 + 4)
  assert.strictEqual(msgs[1].content, '質問8')
  assert.strictEqual(msgs[4].content, '回答9')
})

test('maxItems を超えたら古いものから捨てる', () => {
  const h = new HistoryStore(tmpFile(), { maxItems: 3 })
  for (let i = 0; i < 5; i++) h.add('user', `m${i}`)
  assert.deepStrictEqual(h.list().map((x) => x.content), ['m2', 'm3', 'm4'])
})
