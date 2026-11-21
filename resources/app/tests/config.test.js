'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  DEFAULT_CHARACTER,
  DEFAULT_SETTINGS,
  buildSystemPrompt,
  loadSettings,
  saveSettings,
  parseEnv,
  resolveApiKey,
} = require('../src/core/config')

test('Live2D追加待機モーションは既定で無効', () => {
  assert.equal(DEFAULT_SETTINGS.features.live2dNaturalIdle, false)
  assert.equal(DEFAULT_SETTINGS.features.emotionPersistence, false)
  assert.equal(DEFAULT_SETTINGS.features.lowLatencySpeech, false)
  assert.equal(DEFAULT_SETTINGS.thinkingFillers.enabled, false)
  assert.equal(DEFAULT_SETTINGS.thinkingFillers.frequency, 0.35)
})

test('DeepSeekの旧モデルIDは現行IDへ読み込み時に移行し、設定ファイルは変更しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-model-migration-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ ai: { model: 'deepseek-chat' } }))
  const loaded = loadSettings(file)
  assert.equal(loaded.ai.model, 'deepseek-flash')
  assert.equal(loaded.ai.thinkingMode, 'disabled')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ai.model, 'deepseek-chat')
  fs.writeFileSync(file, JSON.stringify({ ai: { model: 'deepseek-reasoner' } }))
  const reasoner = loadSettings(file)
  assert.equal(reasoner.ai.model, 'deepseek-flash')
  assert.equal(reasoner.ai.thinkingMode, 'enabled')
  fs.writeFileSync(file, 'null')
  assert.equal(loadSettings(file).ai.model, DEFAULT_SETTINGS.ai.model)
  fs.writeFileSync(file, '[]')
  assert.equal(loadSettings(file).ai.model, DEFAULT_SETTINGS.ai.model)
})

test('自発アクションと集中モードは既定OFFで、既存設定読み込み時は安全な既定値で補完', () => {
  assert.equal(DEFAULT_SETTINGS.autonomy.actionsEnabled, false)
  assert.equal(DEFAULT_SETTINGS.autonomy.actionIntervalMinutes, 5)
  assert.equal(DEFAULT_SETTINGS.autonomy.focusMode, false)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-autonomy-config-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ idleTalk:{ enabled:true, intervalMinutes:15 } }))
  const loaded = loadSettings(file)
  assert.equal(loaded.idleTalk.enabled, true)
  assert.equal(loaded.autonomy.actionsEnabled, false)
  assert.equal(loaded.autonomy.focusMode, false)
})

test('カレンダー共有と予定連動は初期OFFで、既存設定にも安全な既定値を補う', () => {
  assert.deepEqual(DEFAULT_SETTINGS.calendar, { shareWithAssistant:false })
  for (const key of ['briefingEnabled','classQuietEnabled','deadlineRemindersEnabled','examRemindersEnabled',
    'eventRemindersEnabled','automaticFollowUpsEnabled','studyRivalEnabled','voiceEnabled','allowCloudVoice']) {
    assert.equal(DEFAULT_SETTINGS.calendarPresence[key], false)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-calendar-config-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ memory:{ longTermEnabled:true, sendContextToDeepSeek:false } }))
  assert.equal(loadSettings(file).calendar.shareWithAssistant, false)
  assert.equal(loadSettings(file).calendarPresence.briefingEnabled, false)
  assert.equal(loadSettings(file).calendarPresence.classQuietEnabled, false)
})

test('システムプロンプトに名前・性格・感情タグ指示が入る', () => {
  const p = buildSystemPrompt(DEFAULT_CHARACTER)
  assert.ok(p.includes('DeepSeekちゃん'))
  assert.ok(p.includes('知的で可愛らしく'))
  assert.ok(p.includes('happy'))
  assert.ok(p.includes('0.0〜1.0'))
  for (const emotion of ['neutral', 'happy', 'shy', 'excited', 'thinking', 'sleepy', 'proud', 'sad', 'annoyed', 'surprised', 'greeting', 'playful', 'flustered', 'confused', 'pout']) assert.ok(p.includes(emotion))
  assert.ok(p.includes('[motion:think]'))
})

test('追加設定がプロンプトに反映される', () => {
  const p = buildSystemPrompt({ ...DEFAULT_CHARACTER, extraPrompt: '語尾は「〜だよ」にする' })
  assert.ok(p.includes('語尾は「〜だよ」にする'))
})

test('parseEnv は引用符とコメントを処理する', () => {
  const env = parseEnv('# c\nDEEPSEEK_API_KEY="sk-abc"\nOTHER= x \nEMPTY=\n')
  assert.strictEqual(env.DEEPSEEK_API_KEY, 'sk-abc')
  assert.strictEqual(env.OTHER, 'x')
  assert.strictEqual(env.EMPTY, '')
})

test('saveSettings は apiKey を書き出さない / loadSettings は既定値で補完する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-config-'))
  const file = path.join(dir, 'settings.json')
  saveSettings(file, { character: { name: 'テストちゃん' }, ai: { apiKey: 'sk-secret' }, apiKey: 'sk-secret' })
  const raw = fs.readFileSync(file, 'utf-8')
  assert.ok(!raw.includes('sk-secret'))
  const loaded = loadSettings(file)
  assert.strictEqual(loaded.character.name, 'テストちゃん')
  assert.strictEqual(loaded.voice.engine, 'qwen3') // 既定値で補完
  assert.strictEqual(loaded.avatar.mode, 'vrm')
})

test('resolveApiKey は環境変数を .env より優先する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-env-'))
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, 'DEEPSEEK_API_KEY=sk-from-file\n')
  assert.strictEqual(resolveApiKey(file, {}), 'sk-from-file')
  assert.strictEqual(resolveApiKey(file, { DEEPSEEK_API_KEY: 'sk-from-env' }), 'sk-from-env')
  assert.strictEqual(resolveApiKey(path.join(dir, 'none.env'), {}), '')
})
