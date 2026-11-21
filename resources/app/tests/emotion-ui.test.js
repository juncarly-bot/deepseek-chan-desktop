'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { CANONICAL_EMOTIONS } = require('../src/core/parser')

test('非表示の声と動きパネルに正式な15感情と口パク試聴・リセットがある', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8')
  const values = [...html.matchAll(/<option value="([a-z]+)">/g)].map(match => match[1])
  assert.deepEqual(values.filter(value => CANONICAL_EMOTIONS.includes(value)), CANONICAL_EMOTIONS)
  assert.match(html, /<section id="voiceStudio" hidden>/)
  assert.match(html, /id="btnVoicePreview">選択した感情で口パク試聴/)
  assert.match(html, /id="btnEmotionReset">自動・通常に戻す/)
})
