'use strict'

const DEFAULTS = Object.freeze({ short: 1.6, long: 2.8 })
const LIMITS = Object.freeze({ short: { min: 1.0, max: 1.6 }, long: { min: 1.4, max: 2.8 } })

function normalizeAudioBufferProfile(value) {
  const profile = {}
  for (const key of ['short', 'long']) {
    const bounds = LIMITS[key]
    const number = Number(value?.[key])
    profile[key] = Number.isFinite(number) ? Math.max(bounds.min, Math.min(bounds.max, number)) : DEFAULTS[key]
  }
  return profile
}

function getInitialAudioBufferSeconds(textLength, profile) {
  const values = normalizeAudioBufferProfile(profile)
  return values[Number(textLength) >= 20 ? 'long' : 'short']
}

function getRecoveryAudioBufferSeconds(initialSeconds, rebufferCount) {
  const initial = Math.max(1.0, Math.min(2.8, Number(initialSeconds) || 1.6))
  const repeatMisses = Math.max(0, Math.min(4, Math.floor(Number(rebufferCount) || 0) - 1))
  return Math.min(2.8, Math.max(1.8, initial + 0.4) + repeatMisses * 0.3)
}

function adaptAudioBufferProfile(profile, textLength, rebufferCount) {
  const values = normalizeAudioBufferProfile(profile)
  const key = Number(textLength) >= 20 ? 'long' : 'short'
  const bounds = LIMITS[key]
  const misses = Math.max(0, Math.min(2, Math.floor(Number(rebufferCount) || 0)))
  values[key] = Math.round((misses
    ? Math.min(bounds.max, values[key] + 0.3 * misses)
    : Math.max(bounds.min, values[key] - 0.2)) * 10) / 10
  return values
}

function summarizeIntervals(values) {
  const sorted = Array.isArray(values) ? values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b) : []
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))] : 0
  return { medianMs:percentile(0.5), p95Ms:percentile(0.95), maxMs:sorted.at(-1) || 0 }
}

const audioBufferApi = { DEFAULTS, normalizeAudioBufferProfile, getInitialAudioBufferSeconds,
  getRecoveryAudioBufferSeconds, adaptAudioBufferProfile, summarizeIntervals }
if (typeof module !== 'undefined' && module.exports) module.exports = audioBufferApi
if (typeof window !== 'undefined') window.AudioBufferTuner = audioBufferApi
