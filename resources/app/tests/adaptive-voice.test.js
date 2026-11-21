'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Selector, wantsFullReading, needsCaution } = require('../src/core/adaptive-voice')
const { DEFAULT_SETTINGS } = require('../src/core/config')

function run(chunks) {
  const selector = new Selector()
  return [...chunks.flatMap(chunk => selector.push(chunk)), ...selector.finish()]
}
test('簡潔モードは初期OFF、全文指定を認識', () => {
  assert.equal(DEFAULT_SETTINGS.features.adaptiveVoiceResponse, false)
  assert.equal(wantsFullReading('省略せずに全文読み上げて'), true)
  assert.equal(wantsFullReading('全文の意味を説明して'), false)
})
test('任意のSSE分割で最初の文だけを感情付きで出力', () => {
  const text = '[shy:0.7]まず対称性を確認するよ。詳しい導出が続くよ。'
  for (let i = 0; i <= text.length; i++) {
    const plans = run([text.slice(0, i), text.slice(i)])
    assert.equal(plans.length, 1)
    assert.equal(plans[0].text, 'まず対称性を確認するよ。')
    assert.equal(plans[0].cues[0].emotion, 'shy')
  }
})
test('数式・長い先頭文・不完全タグは安全な案内にする', () => {
  for (const text of ['[happy]式は $E=mc^2$ です。', 'あ'.repeat(181), '[happy']) {
    const plans = run([text])
    assert.equal(plans[0].text, '詳しい説明は画面にまとめるね。')
  }
  assert.deepEqual(run(['']), [])
})
test('最初の文確定後は続く文章を読み上げない', () => {
  const selector = new Selector()
  assert.equal(selector.push('[happy]こんにちは。')[0].text, 'こんにちは。')
  assert.deepEqual(selector.push('これ以降は画面に表示。'), [])
  assert.deepEqual(selector.finish(), [])
})
test('物理や数式の質問は条件の抜けた結論を読み上げず画面へ案内', () => {
  assert.equal(needsCaution('ガウスの法則を教えて'), true)
  const selector = new Selector({ cautious:true })
  assert.deepEqual(selector.push('[thinking]'), [])
  assert.equal(selector.push('電場はゼロです。')[0].text, '詳しい説明は画面にまとめるね。')
  for (const sentence of ['[thinking]まず対称性を確認しよう。', '[neutral]まず条件を確認してみよう。']) {
    for (let i = 0; i <= sentence.length; i++) {
      const s = new Selector({ cautious:true })
      const plans = [...s.push(sentence.slice(0, i)), ...s.push(sentence.slice(i)), ...s.finish()]
      assert.equal(plans[0].text, sentence.replace(/^\[[^\]]+\]/, ''))
    }
  }
  for (const sentence of ['まず対称性を確認しない。', 'まず条件が1つ必要です。', 'まず対称性を確認しよう']) {
    const s = new Selector({ cautious:true })
    const plans = [...s.push(sentence), ...s.finish()]
    assert.equal(plans[0].text, '詳しい説明は画面にまとめるね。')
  }
})
