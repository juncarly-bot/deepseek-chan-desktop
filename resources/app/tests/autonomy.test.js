'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { AutonomyGuard, canRunAutonomousAction, SPEECH_COOLDOWN_MS,
  MAX_SPEECHES_PER_HOUR } = require('../src/core/autonomy')

test('自発発話は無効・音声OFF・集中・会話中・待機不足では開始しない', () => {
  const guard = new AutonomyGuard()
  const base = { enabled:true, voiceEnabled:true, focusMode:false, busy:false,
    idleForMs:900_000, idleThresholdMs:900_000, now:1_000_000 }
  assert.equal(guard.canSpeak(base), true)
  for (const patch of [
    { enabled:false }, { voiceEnabled:false }, { focusMode:true }, { busy:true }, { idleForMs:1 },
  ]) assert.equal(guard.canSpeak({ ...base, ...patch }), false)
})

test('自発発話は5分のクールダウンと1時間3回の上限を守る', () => {
  const guard = new AutonomyGuard()
  assert.equal(guard.beginSpeech(1_000_000), true)
  assert.equal(guard.beginSpeech(1_000_001), false, '二重実行を抑止')
  guard.finishSpeech()
  assert.equal(guard.canSpeak({ enabled:true, voiceEnabled:true, idleForMs:900_000,
    idleThresholdMs:900_000, now:1_000_000 + SPEECH_COOLDOWN_MS - 1 }), false)
  for (let i = 1; i < MAX_SPEECHES_PER_HOUR; i++) {
    const now = 1_000_000 + SPEECH_COOLDOWN_MS * i
    assert.equal(guard.beginSpeech(now), true)
    guard.finishSpeech()
  }
  const cappedAt = 1_000_000 + SPEECH_COOLDOWN_MS * MAX_SPEECHES_PER_HOUR
  assert.equal(guard.canSpeak({ enabled:true, voiceEnabled:true, idleForMs:900_000,
    idleThresholdMs:900_000, now:cappedAt }), false)
  assert.equal(guard.canSpeak({ enabled:true, voiceEnabled:true, idleForMs:900_000,
    idleThresholdMs:900_000, now:1_000_000 + 60 * 60 * 1000 + 1 }), true)
})

test('時間あたりの独り言制限は再起動後も時刻だけを復元し、期限切れ記録を捨てる', () => {
  const now = 10_000_000
  const original = new AutonomyGuard()
  for (let i = 0; i < MAX_SPEECHES_PER_HOUR; i++) {
    assert.equal(original.beginSpeech(now - (MAX_SPEECHES_PER_HOUR - i - 1) * SPEECH_COOLDOWN_MS), true)
    original.finishSpeech()
  }
  const state = original.snapshot(now)
  const restored = new AutonomyGuard()
  restored.restoreState([...state.speechStarts, now + 10_000], now + 100)
  assert.equal(restored.beginSpeech(now + 100), false)
  assert.equal(restored.snapshot(now + 100).speechStarts.length, MAX_SPEECHES_PER_HOUR)
  restored.restoreState(state.speechStarts, now + 60 * 60 * 1000 + 1)
  assert.equal(restored.beginSpeech(now + 60 * 60 * 1000 + 1), true)
})

test('自発動作は別フラグで動き、集中・会話中・無操作時間不足なら停止', () => {
  const base = { enabled:true, focusMode:false, busy:false, idleForMs:300_000, idleThresholdMs:300_000 }
  assert.equal(canRunAutonomousAction(base), true)
  assert.equal(canRunAutonomousAction({ ...base, enabled:false }), false)
  assert.equal(canRunAutonomousAction({ ...base, focusMode:true }), false)
  assert.equal(canRunAutonomousAction({ ...base, busy:true }), false)
  assert.equal(canRunAutonomousAction({ ...base, idleForMs:0 }), false)
})
