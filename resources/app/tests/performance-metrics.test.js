'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPerformanceMetrics } = require('../src/core/performance-metrics')

test('performance metrics persist only allowlisted, non-content fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-metrics-'))
  const filePath = path.join(dir, 'metrics.jsonl')
  const metrics = createPerformanceMetrics({ filePath })
  assert.equal(metrics.record('llm.first_token', {
    turnId: 'sample-turn-1', elapsedMs: 123, text: 'private chat', apiKey: 'sk-private',
  }), true)
  const row = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(row.event, 'llm.first_token')
  assert.equal(row.elapsedMs, 123)
  assert.equal(row.text, undefined)
  assert.equal(row.apiKey, undefined)
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('private'), false)
})

test('unknown events and invalid IDs are rejected; numeric values are bounded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-metrics-'))
  const filePath = path.join(dir, 'metrics.jsonl')
  const metrics = createPerformanceMetrics({ filePath })
  assert.equal(metrics.record('user.message', { text: 'hello' }), false)
  metrics.record('render.sample', { turnId: 'bad id', fps: Infinity, jsHeapMB: 1e20 })
  const row = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(row.turnId, undefined)
  assert.equal(row.fps, undefined)
  assert.equal(row.jsHeapMB, 1e9)
})

test('metrics log rotates at its configured size bound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-metrics-'))
  const filePath = path.join(dir, 'metrics.jsonl')
  const metrics = createPerformanceMetrics({ filePath, maxBytes: 1 })
  metrics.record('process.sample', { processCount: 2 })
  metrics.record('process.sample', { processCount: 3 })
  assert.equal(fs.existsSync(`${filePath}.1`), true)
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).processCount, 3)
})

test('audio diagnostics persist timing aggregates only and never audio or utterance text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-audio-metrics-'))
  const filePath = path.join(dir, 'metrics.jsonl')
  const metrics = createPerformanceMetrics({ filePath })
  metrics.record('audio.stream_completed', {
    turnId:'turn-1', generationElapsedMs:1000, audioSeconds:2, chunkCount:8,
    chunkGapMedianMs:250, chunkGapP95Ms:360, generationRealtimeFactor:2,
    transcript:'private text', apiKey:'sk-secret', pcm:'private waveform',
  })
  metrics.record('audio.sentence_boundary', { turnId:'turn-1', gapMs:42, transcript:'private text' })
  const rows = fs.readFileSync(filePath, 'utf8')
  assert.equal(rows.includes('private'), false)
  assert.equal(rows.includes('sk-secret'), false)
  assert.equal(rows.includes('waveform'), false)
  const [stream, boundary] = rows.trim().split('\n').map(JSON.parse)
  assert.equal(stream.chunkGapP95Ms, 360)
  assert.equal(stream.transcript, undefined)
  assert.equal(boundary.gapMs, 42)
})
