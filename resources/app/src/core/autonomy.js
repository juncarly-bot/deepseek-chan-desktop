'use strict'

const SPEECH_COOLDOWN_MS = 5 * 60 * 1000
const SPEECH_WINDOW_MS = 60 * 60 * 1000
const MAX_SPEECHES_PER_HOUR = 3

class AutonomyGuard {
  constructor({ cooldownMs = SPEECH_COOLDOWN_MS, windowMs = SPEECH_WINDOW_MS,
    maxPerWindow = MAX_SPEECHES_PER_HOUR } = {}) {
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0)
    this.windowMs = Math.max(1, Number(windowMs) || SPEECH_WINDOW_MS)
    this.maxPerWindow = Math.max(0, Math.floor(Number(maxPerWindow) || 0))
    this.speechStarts = []
    this.lastSpeechAt = -Infinity
    this.speechInFlight = false
  }

  restoreState(starts, now = Date.now()) {
    const valid = Array.isArray(starts)
      ? starts.filter(at => Number.isFinite(at) && at <= now && now - at < this.windowMs)
      : []
    this.speechStarts = this.maxPerWindow ? valid.slice(-this.maxPerWindow) : []
    this.lastSpeechAt = this.speechStarts.length ? Math.max(...this.speechStarts) : -Infinity
  }

  snapshot(now = Date.now()) {
    this.speechStarts = this.speechStarts.filter(at => Number.isFinite(at) && at <= now && now - at < this.windowMs)
    return { version:1, speechStarts:[...this.speechStarts] }
  }

  canSpeak({ enabled, voiceEnabled, focusMode, busy, idleForMs, idleThresholdMs, now = Date.now() } = {}) {
    this.speechStarts = this.speechStarts.filter(at => now - at < this.windowMs)
    if (!enabled || !voiceEnabled || focusMode || busy || this.speechInFlight) return false
    if (!Number.isFinite(idleForMs) || idleForMs < Math.max(0, Number(idleThresholdMs) || 0)) return false
    if (now - this.lastSpeechAt < this.cooldownMs) return false
    return this.speechStarts.length < this.maxPerWindow
  }

  beginSpeech(now = Date.now()) {
    this.speechStarts = this.speechStarts.filter(at => now - at < this.windowMs)
    if (this.speechInFlight || now - this.lastSpeechAt < this.cooldownMs
        || this.speechStarts.length >= this.maxPerWindow) return false
    this.lastSpeechAt = now
    this.speechStarts.push(now)
    this.speechInFlight = true
    return true
  }

  finishSpeech() {
    this.speechInFlight = false
  }
}

function canRunAutonomousAction({ enabled, focusMode, busy, idleForMs, idleThresholdMs } = {}) {
  return enabled === true && focusMode !== true && busy !== true
    && Number.isFinite(idleForMs) && idleForMs >= Math.max(0, Number(idleThresholdMs) || 0)
}

module.exports = {
  AutonomyGuard,
  canRunAutonomousAction,
  SPEECH_COOLDOWN_MS,
  SPEECH_WINDOW_MS,
  MAX_SPEECHES_PER_HOUR,
}
