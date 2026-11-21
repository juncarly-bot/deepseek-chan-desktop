'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { hintForStatus, errorFromResponse } = require('../src/core/deepseek')

test('401 は仮キー・無効キーの対処ヒントを返す', () => {
  const hint = hintForStatus(401)
  assert.ok(hint.includes('APIキーが無効'))
  assert.ok(hint.includes('仮キー'))
})

test('402 は残高不足、429 はレート制限、その他は空', () => {
  assert.ok(hintForStatus(402).includes('残高'))
  assert.ok(hintForStatus(429).includes('集中'))
  assert.strictEqual(hintForStatus(418), '')
})

test('errorFromResponse は status とヒントを含む DeepSeekError を作る', () => {
  const e = errorFromResponse(401, 'auth failed')
  assert.strictEqual(e.name, 'DeepSeekError')
  assert.strictEqual(e.status, 401)
  assert.ok(e.message.includes('401'))
  assert.ok(e.message.includes('APIキーが無効'))
  assert.strictEqual(e.body, 'auth failed')
})
