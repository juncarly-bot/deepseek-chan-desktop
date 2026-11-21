'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULTS, getInitialAudioBufferSeconds, getRecoveryAudioBufferSeconds, adaptAudioBufferProfile, summarizeIntervals } = require('../src/core/audio-buffer')

test('adaptive startup buffer begins with the current safe values and separates short/long plans', () => {
  assert.equal(getInitialAudioBufferSeconds(19, DEFAULTS), 1.6)
  assert.equal(getInitialAudioBufferSeconds(20, DEFAULTS), 2.8)
})

test('gap-free playback gradually reduces lead while an underrun increases it again', () => {
  const start = { ...DEFAULTS }
  const steady = adaptAudioBufferProfile(start, 42, 0)
  assert.equal(steady.long, 2.6)
  const recovered = adaptAudioBufferProfile(steady, 42, 1)
  assert.equal(recovered.long, 2.8)
  assert.equal(adaptAudioBufferProfile({ short: 1, long: 1.4 }, 4, 0).short, 1)
})

test('buffer tuning clamps persisted values and ignores invalid rebuffer counters', () => {
  assert.equal(getInitialAudioBufferSeconds(80, { long: -100 }), 1.4)
  assert.equal(adaptAudioBufferProfile({ short: 99, long: 99 }, 80, 1).long, 2.8)
  assert.equal(adaptAudioBufferProfile(DEFAULTS, 80, -3).long, 2.6)
})

test('recovery lead starts short after a gap and grows only after repeated underruns', () => {
  assert.equal(getRecoveryAudioBufferSeconds(1.0, 1), 1.8)
  assert.equal(getRecoveryAudioBufferSeconds(1.0, 2), 2.1)
  assert.equal(getRecoveryAudioBufferSeconds(2.8, 1), 2.8)
  assert.equal(getRecoveryAudioBufferSeconds(1.0, 99), 2.8)
})

test('arrival interval summary reports median, p95, and maximum without mutating input', () => {
  const values = [300, 100, 200, -10, Number.NaN]
  assert.deepEqual(summarizeIntervals(values), { medianMs:200, p95Ms:300, maxMs:300 })
  assert.deepEqual(values.slice(0, 3), [300, 100, 200])
  assert.deepEqual(summarizeIntervals([]), { medianMs:0, p95Ms:0, maxMs:0 })
})
