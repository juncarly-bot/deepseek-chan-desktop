'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { StreamingSpeechChunker } = require('../src/core/streaming-speech')

test('SSE文字列を句点で逐次発話へ確定し、文の順序と感情タグを保つ', () => {
  const chunks = new StreamingSpeechChunker()
  assert.deepEqual(chunks.push('[happy:0.7]こんにちは、きみ。次の文'), [
    { text: 'こんにちは、きみ。', cues: [{ offset: 0, emotion: 'happy', intensity: 0.7, motion: null }] },
  ])
  assert.deepEqual(chunks.push('も届いたよ！'), [
    { text: '次の文も届いたよ！', cues: [{ offset: 0, emotion: 'happy', intensity: 0.7, motion: null }] },
  ])
  assert.deepEqual(chunks.finish(), [])
})

test('タグが分割到着しても最終文をflushし、未知タグを読み上げない', () => {
  const chunks = new StreamingSpeechChunker()
  assert.deepEqual(chunks.push('[conf'), [])
  assert.deepEqual(chunks.push('used]えっと、そうなの？ [bad]'), [
    { text: 'えっと、そうなの？', cues: [{ offset: 0, emotion: 'confused', intensity: undefined, motion: null }] },
  ])
  assert.deepEqual(chunks.finish(), [])
})

test('句点のない終端文もfinishで一度だけ発話へ渡す', () => {
  const chunks = new StreamingSpeechChunker()
  assert.deepEqual(chunks.push('[shy]ありがとう'), [])
  assert.deepEqual(chunks.finish(), [
    { text: 'ありがとう', cues: [{ offset: 0, emotion: 'shy', intensity: undefined, motion: null }] },
  ])
  assert.deepEqual(chunks.finish(), [])
})
