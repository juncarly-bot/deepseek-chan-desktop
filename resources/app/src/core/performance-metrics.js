'use strict'

const fs = require('fs')
const path = require('path')

// Allowlisted metadata only: never persist chat text, audio, API credentials, or exception bodies.
const FIELDS = {
  'user.input': ['inputChars'],
  'llm.first_token': ['elapsedMs'],
  'llm.completed': ['elapsedMs'],
  'speech.plan_ready': ['elapsedMs', 'planCount', 'textChars'],
  'tts.request_start': ['elapsedMs'],
  'tts.first_audio': ['elapsedMs', 'bytes'],
  'audio.first_scheduled': ['elapsedMs', 'scheduledLeadMs'],
  'audio.output_started': ['elapsedMs', 'clockSource'],
  'audio.stream_completed': ['elapsedMs', 'generationElapsedMs', 'audioSeconds', 'rebufferCount',
    'chunkCount', 'chunkGapMedianMs', 'chunkGapP95Ms', 'chunkGapMaxMs', 'generationRealtimeFactor',
    'maxRebufferGapMs', 'scheduledGapCount'],
  'audio.sentence_boundary': ['gapMs', 'audioSeconds'],
  'audio.rebuffer': ['gapMs', 'audioSeconds'],
  'filler.started': ['elapsedMs', 'phraseIndex', 'position'],
  'filler.transition': ['gapMs', 'position', 'transitionStyle'],
  'filler.cache_quality': ['phraseIndex', 'tokenBudget', 'totalMs', 'speechMs', 'leadingSilenceMs',
    'trailingSilenceMs', 'peakRms', 'clippedRatio', 'accepted'],
  'turn.failed': ['elapsedMs'],
  'render.sample': ['fps', 'jsHeapMB'],
  'process.sample': ['cpuPercent', 'workingSetMB', 'processCount'],
}

function createPerformanceMetrics({ filePath, maxBytes = 2 * 1024 * 1024, now = () => new Date() }) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required')

  function record(event, input = {}) {
    const allowed = FIELDS[event]
    if (!allowed || !input || typeof input !== 'object') return false
    const row = { at: now().toISOString(), event }
    if (typeof input.turnId === 'string' && /^[a-z0-9-]{1,80}$/i.test(input.turnId)) row.turnId = input.turnId
    for (const key of allowed) {
      const value = input[key]
      if (typeof value === 'number' && Number.isFinite(value)) row[key] = Math.max(0, Math.min(1e9, value))
      else if (key === 'clockSource' && ['audio-output', 'audio-context'].includes(value)) row[key] = value
      else if (key === 'position' && ['opening', 'gap'].includes(value)) row[key] = value
      else if (key === 'transitionStyle' && ['natural', 'fade'].includes(value)) row[key] = value
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      try {
        if (fs.statSync(filePath).size >= maxBytes) {
          const previous = `${filePath}.1`
          try { fs.rmSync(previous, { force: true }) } catch {}
          fs.renameSync(filePath, previous)
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' })
      return true
    } catch {
      // Diagnostics must not interrupt the conversation.
      return false
    }
  }

  return { record }
}

module.exports = { createPerformanceMetrics }
