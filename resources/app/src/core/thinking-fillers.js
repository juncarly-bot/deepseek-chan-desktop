'use strict'

const FILLER_PHRASES = Object.freeze([
  { id:'hmm', text:'うーん' },
  { id:'eto', text:'ええと' },
  { id:'soudesune', text:'そうですね' },
  { id:'n', text:'んー' },
  { id:'naruhodo', text:'なるほど' },
])
const FILLER_MODES = Object.freeze(['none', 'opening', 'opening-gap'])
const FILLER_START_DELAYS_MS = Object.freeze([550, 1000, 1500])

function normalizeThinkingFillers(value = {}) {
  const phrases = Array.isArray(value.phrases)
    ? [...new Set(value.phrases.filter(id => FILLER_PHRASES.some(phrase => phrase.id === id)))]
    : FILLER_PHRASES.map(phrase => phrase.id)
  const frequency = Number(value.frequency)
  return {
    enabled: value.enabled === true,
    mode: FILLER_MODES.includes(value.mode) ? value.mode : 'opening',
    startDelayMs: FILLER_START_DELAYS_MS.includes(Number(value.startDelayMs)) ? Number(value.startDelayMs) : 1000,
    frequency: Number.isFinite(frequency) ? Math.max(0, Math.min(0.85, frequency)) : 0.35,
    phrases,
  }
}

function cacheStorageKey(voiceFingerprint) {
  if (typeof voiceFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(voiceFingerprint)) return null
  return `deepseek-chan-thinking-fillers-v1:${voiceFingerprint.toLowerCase()}`
}

function fillerTokenBudget(text) {
  const length = [...String(text || '')].length
  return Math.min(20, Math.max(10, length * 2 + 6))
}

function analyzeFillerSamples(samples, sampleRate = 24000) {
  if (!(samples instanceof Float32Array) || !samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { accepted:false, reason:'invalid-audio' }
  }
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.02))
  const rmsThreshold = 0.005
  const rmsByWindow = []
  let peak = 0
  let peakRms = 0
  let clippedSamples = 0
  for (let i = 0; i < samples.length; i += windowSamples) {
    const end = Math.min(samples.length, i + windowSamples)
    let sum = 0
    for (let j = i; j < end; j++) {
      const value = samples[j]
      peak = Math.max(peak, Math.abs(value))
      if (Math.abs(value) >= 0.999) clippedSamples++
      sum += value * value
    }
    const rms = Math.sqrt(sum / Math.max(1, end - i))
    peakRms = Math.max(peakRms, rms)
    rmsByWindow.push(rms)
  }
  const activeWindows = []
  for (let i = 0; i < rmsByWindow.length; i++) if (rmsByWindow[i] >= rmsThreshold) activeWindows.push(i)
  if (!activeWindows.length) return { accepted:false, reason:'silent', peakRms }
  const firstWindow = activeWindows[0]
  const lastWindow = activeWindows[activeWindows.length - 1]
  const activeDurationMs = activeWindows.length * 20
  const leadingSilenceMs = firstWindow * 20
  const trailingSilenceMs = Math.max(0, (rmsByWindow.length - lastWindow - 1) * 20)
  const start = Math.max(0, firstWindow * windowSamples - Math.round(sampleRate * 0.04))
  const end = Math.min(samples.length, (lastWindow + 1) * windowSamples + Math.round(sampleRate * 0.06))
  const trimmed = samples.slice(start, end)
  const durationMs = trimmed.length / sampleRate * 1000
  const clippedRatio = clippedSamples / samples.length
  const accepted = activeDurationMs >= 550 && activeDurationMs <= 1500
    && peakRms >= 0.02 && peakRms < 0.98 && clippedRatio <= 0.005
  const reason = accepted ? null : activeDurationMs < 550 ? 'too-short'
    : activeDurationMs > 1500 ? 'too-long'
      : peakRms < 0.02 ? 'too-quiet' : peakRms >= 0.98 || clippedRatio > 0.005 ? 'clipped' : 'invalid-audio'
  return { accepted, reason, samples:trimmed, durationMs, activeDurationMs, leadingSilenceMs,
    trailingSilenceMs, peakRms, peakAmplitude:peak, clippedRatio }
}

function findQuietBoundary(samples, fromSample, sampleRate = 24000, maxWaitMs = 120, threshold = 0.008) {
  if (!(samples instanceof Float32Array) || !samples.length || !Number.isFinite(fromSample)) return null
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.01))
  const start = Math.max(0, Math.floor(fromSample / windowSamples) * windowSamples)
  const endLimit = Math.min(samples.length, start + Math.round(sampleRate * maxWaitMs / 1000))
  for (let offset = start; offset + windowSamples * 2 <= endLimit; offset += windowSamples) {
    let firstSum = 0, secondSum = 0
    for (let i = 0; i < windowSamples; i++) {
      const a = samples[offset + i], b = samples[offset + windowSamples + i]
      firstSum += a * a
      secondSum += b * b
    }
    if (Math.sqrt(firstSum / windowSamples) <= threshold && Math.sqrt(secondSum / windowSamples) <= threshold) return offset
  }
  return null
}

function selectFiller({ config, position, cachedIds, history = [], random = Math.random }) {
  const settings = normalizeThinkingFillers(config)
  if (!settings.enabled || !settings.phrases.length || settings.frequency <= 0) return null
  const modeAllows = position === 'opening'
    ? settings.mode === 'opening' || settings.mode === 'opening-gap'
    : position === 'gap' && settings.mode === 'opening-gap'
  if (!modeAllows || random() >= settings.frequency) return null
  const cached = new Set(Array.isArray(cachedIds) ? cachedIds : [])
  const recent = new Set(history.slice(-2).map(item => typeof item === 'string' ? item : item?.id))
  const candidates = settings.phrases.filter(id => cached.has(id))
  const fresh = candidates.filter(id => !recent.has(id))
  const pool = fresh
  if (!pool.length) return null
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * pool.length))
  return FILLER_PHRASES.find(phrase => phrase.id === pool[index]) || null
}

const thinkingFillerApi = { FILLER_PHRASES, FILLER_MODES, FILLER_START_DELAYS_MS, normalizeThinkingFillers,
  cacheStorageKey, fillerTokenBudget, analyzeFillerSamples, findQuietBoundary, selectFiller }
if (typeof module !== 'undefined' && module.exports) module.exports = thinkingFillerApi
if (typeof window !== 'undefined') window.ThinkingFillers = thinkingFillerApi
