'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSpeechMotionCues } = require('../src/core/avatar-motion.js')

test('文末の句読点にだけ手を使わない軽いうなずきを配置する', () => {
  const cues = buildSpeechMotionCues('こんにちは。今日は元気？そうならよかったです。')
  assert.deepEqual(cues.map(cue => cue.offset), [6, 23])
  assert.ok(cues.every(cue => cue.motion === 'nod'))
})

test('短い相づちと読点の連続でうなずきが増えすぎない', () => {
  assert.deepEqual(buildSpeechMotionCues('うん。'), [])
  const cues = buildSpeechMotionCues('そうですね、たしかに、そう思います。')
  assert.deepEqual(cues.map(cue => cue.offset), [18])
})
