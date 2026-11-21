'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { EMOTIONS, CANONICAL_EMOTIONS, parseEmotionTags, cleanText, splitSentences, buildSpeechPlan } = require('../src/core/parser')

test('正式な15感情と既存タグを両方認識し、未知タグはneutralに戻す', () => {
  assert.equal(CANONICAL_EMOTIONS.length, 15)
  for (const emotion of CANONICAL_EMOTIONS) {
    assert.equal(parseEmotionTags(`[${emotion}]確認`)[0].emotion, emotion)
  }
  for (const emotion of ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised']) {
    assert.equal(parseEmotionTags(`[${emotion}]旧タグ`)[0].emotion, emotion)
  }
  assert.deepStrictEqual(parseEmotionTags('[alien:0.9]安全に戻る'), [{ emotion: 'neutral', motion: null, text: '安全に戻る' }])
  assert.equal(cleanText('[alien]タグは読まない'), 'タグは読まない')
})

test('複数文と感情を一つの読み上げにまとめる', () => {
  const plans = buildSpeechPlan(parseEmotionTags('[surprised:0.8]えっ、本当？[happy:0.9]それはうれしいね！[relaxed:0.4]ゆっくり教えて。'))
  assert.equal(plans.length, 1)
  assert.equal(plans[0].text, 'えっ、本当？それはうれしいね！ゆっくり教えて。')
  assert.deepStrictEqual(plans[0].cues.map(c => [c.offset, c.emotion, c.intensity]), [[0, 'surprised', 0.8], [6, 'happy', 0.9], [15, 'relaxed', 0.4]])
})

test('長すぎる返答だけを上限以内に分割し、絵文字を壊さない', () => {
  const text = 'あ'.repeat(259) + '🐟' + 'い'.repeat(300)
  const plans = buildSpeechPlan([{text, emotion: 'happy', motion: null}])
  assert.ok(plans.length > 1)
  assert.ok(plans.every(p => p.text.length <= 300))
  assert.equal(plans.map(p => p.text).join(''), text)
})

test('すべての表情タグを解析して会話本文から除く', () => {
  for (const emotion of EMOTIONS) {
    const tagged = `[${emotion}:0.8]こんにちは。`
    assert.strictEqual(parseEmotionTags(tagged)[0].emotion, emotion)
    assert.strictEqual(parseEmotionTags(tagged)[0].intensity, 0.8)
    assert.strictEqual(cleanText(tagged), 'こんにちは。')
  }
})

test('文ごとの感情の強さを読み取り、表示や音声からタグを除く', () => {
  const raw = '[surprised:0.8]えっ、本当？[happy:0.9]それはうれしいね！[relaxed:0.4]ゆっくり教えて。'
  const segments = parseEmotionTags(raw)
  assert.deepStrictEqual(segments.map(({emotion, intensity, text}) => ({emotion, intensity, text})), [
    {emotion: 'surprised', intensity: 0.8, text: 'えっ、本当？'},
    {emotion: 'happy', intensity: 0.9, text: 'それはうれしいね！'},
    {emotion: 'relaxed', intensity: 0.4, text: 'ゆっくり教えて。'},
  ])
  assert.strictEqual(cleanText(raw), 'えっ、本当？それはうれしいね！ゆっくり教えて。')
})

test('感情の強さは1を超えず、従来のタグも使える', () => {
  const segments = parseEmotionTags('[HAPPY:2]うれしい！[sad]少し寂しい。')
  assert.strictEqual(segments[0].intensity, 1)
  assert.strictEqual(segments[1].emotion, 'sad')
  assert.strictEqual(segments[1].intensity, undefined)
})

test('感情タグとモーションタグを解析できる', () => {
  const segs = parseEmotionTags('[happy][motion:wave]やっほー！[sad]でも少し寂しい。')
  assert.strictEqual(segs.length, 2)
  assert.strictEqual(segs[0].emotion, 'happy')
  assert.strictEqual(segs[0].motion, 'wave')
  assert.strictEqual(segs[0].text, 'やっほー！')
  assert.strictEqual(segs[1].emotion, 'sad')
})

test('タグなしテキストは neutral 1セグメントになる', () => {
  const segs = parseEmotionTags('こんにちは')
  assert.deepStrictEqual(segs, [{ emotion: 'neutral', motion: null, text: 'こんにちは' }])
})

test('cleanText はタグを取り除く', () => {
  assert.strictEqual(cleanText('[happy]うれしい！[motion:cheer]'), 'うれしい！')
})

test('未知のモーションは無効化される', () => {
  const segs = parseEmotionTags('[motion:fly]テスト')
  assert.strictEqual(segs[0].motion, null)
})

test('splitSentences は文単位に分割しタグを除去する', () => {
  const out = splitSentences('[happy]一つ目です。二つ目！三つ目？')
  assert.deepStrictEqual(out, ['一つ目です。', '二つ目！', '三つ目？'])
})

test('splitSentences は長文を読点で分割する', () => {
  const long = 'あ'.repeat(50) + '、' + 'い'.repeat(50) + '、' + 'う'.repeat(50)
  const out = splitSentences(long, 90)
  assert.ok(out.length >= 2)
  assert.ok(out.every((s) => s.length <= 95))
})
