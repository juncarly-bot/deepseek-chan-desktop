'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULT_SETTINGS } = require('../src/core/config')
const { FILLER_PHRASES, normalizeThinkingFillers, cacheStorageKey, fillerTokenBudget,
  analyzeFillerSamples, findQuietBoundary, selectFiller } = require('../src/core/thinking-fillers')

test('思考フィラーは初期OFFで、設定値は安全な候補と頻度へ正規化される', () => {
  assert.equal(DEFAULT_SETTINGS.thinkingFillers.enabled, false)
  assert.equal(DEFAULT_SETTINGS.thinkingFillers.mode, 'opening')
  assert.equal(DEFAULT_SETTINGS.thinkingFillers.startDelayMs, 1000)
  assert.deepEqual(normalizeThinkingFillers({ enabled:true, mode:'invalid', frequency:3,
    phrases:['hmm','unknown','hmm'] }), {
    enabled:true, mode:'opening', startDelayMs:1000, frequency:0.85, phrases:['hmm'],
  })
})

test('方式ごとに冒頭と文間を分け、未キャッシュ候補を使わない', () => {
  const cachedIds = FILLER_PHRASES.map(row => row.id)
  const opening = { enabled:true, mode:'opening', frequency:1, phrases:['hmm'] }
  const both = { ...opening, mode:'opening-gap' }
  const never = { ...opening, mode:'none' }
  assert.equal(selectFiller({ config:opening, position:'opening', cachedIds, random:() => 0 })?.id, 'hmm')
  assert.equal(selectFiller({ config:opening, position:'gap', cachedIds, random:() => 0 }), null)
  assert.equal(selectFiller({ config:both, position:'gap', cachedIds, random:() => 0 })?.id, 'hmm')
  assert.equal(selectFiller({ config:never, position:'opening', cachedIds, random:() => 0 }), null)
  assert.equal(selectFiller({ config:opening, position:'opening', cachedIds:[], random:() => 0 }), null)
})

test('使用頻度と直近履歴が乱用と同じ音の連続を抑える', () => {
  const config = { enabled:true, mode:'opening', frequency:0.35, phrases:['hmm','eto'] }
  const history = [{ id:'hmm', at:1000 }]
  assert.equal(selectFiller({ config, position:'opening', cachedIds:['hmm','eto'], history, random:() => 0 })?.id, 'eto')
  assert.equal(selectFiller({ config, position:'opening', cachedIds:['hmm'], history, random:() => 0 }), null)
  assert.equal(selectFiller({ config, position:'opening', cachedIds:['hmm','eto'], random:() => 0.9 }), null)
})

test('キャッシュキーはQwen声質の指紋だけを受け付ける', () => {
  assert.equal(cacheStorageKey('not-a-hash'), null)
  assert.equal(cacheStorageKey('A'.repeat(64)), `deepseek-chan-thinking-fillers-v1:${'a'.repeat(64)}`)
})

test('短いフィラーはQwenの生成トークン数を抑え、通常発話の上限を変えない', () => {
  assert.equal(fillerTokenBudget('うーん'), 12)
  assert.equal(fillerTokenBudget('そうですね'), 16)
  assert.equal(fillerTokenBudget('あ'.repeat(30)), 20)
})

test('開始遅延は550/1000/1500msに限定し、頻度は85%以下に制限する', () => {
  assert.equal(normalizeThinkingFillers({ startDelayMs:550, frequency:1 }).startDelayMs, 550)
  assert.equal(normalizeThinkingFillers({ startDelayMs:1500, frequency:1 }).startDelayMs, 1500)
  assert.equal(normalizeThinkingFillers({ startDelayMs:800, frequency:1 }).startDelayMs, 1000)
  assert.equal(normalizeThinkingFillers({ frequency:1 }).frequency, 0.85)
})

test('無音だけを前後に残して短いフィラーを評価し、長音声は不採用にする', () => {
  const samples = new Float32Array(24000 * 1.5)
  for (let i = 24000 * 0.25; i < 24000 * 1.25; i++) samples[i] = Math.sin(i * 2 * Math.PI * 220 / 24000) * 0.1
  const result = analyzeFillerSamples(samples)
  assert.equal(result.accepted, true)
  assert.equal(result.leadingSilenceMs, 240)
  assert.equal(result.trailingSilenceMs, 240)
  assert.ok(result.durationMs >= 1000 && result.durationMs <= 1150)
  const tooLong = analyzeFillerSamples(new Float32Array(24000 * 2).fill(0.1))
  assert.equal(tooLong.reason, 'too-long')
})

test('切り替え用の近い低音量境界を探し、境界がなければフェードへ回せる', () => {
  const samples = new Float32Array(1000)
  samples.fill(0.1, 0, 700)
  assert.equal(findQuietBoundary(samples, 500, 1000, 300), 700)
  samples.fill(0.1)
  assert.equal(findQuietBoundary(samples, 500, 1000, 300), null)
})
