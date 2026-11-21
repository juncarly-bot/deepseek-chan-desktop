'use strict'
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.SilentReactions = factory()
})(typeof window === 'undefined' ? globalThis : window, function () {
  const labels = Object.freeze({ thinking:'考え中…', surprised:'！', proud:'ふふん', confused:'……？' })
  class Limiter {
    constructor({ cooldownMs = 30000, hourlyLimit = 3 } = {}) {
      this.cooldownMs = cooldownMs
      this.hourlyLimit = hourlyLimit
      this.shown = []
      this.generation = 0
    }
    invalidate() { this.generation++ }
    ticket() { return this.generation }
    allow(label, now, ticket) {
      if (ticket !== this.generation || !Object.hasOwn(labels, label) || !Number.isFinite(now)) return false
      this.shown = this.shown.filter(t => now >= t && now - t < 3600000)
      if (this.shown.length >= this.hourlyLimit || (this.shown.length && now - this.shown.at(-1) < this.cooldownMs)) return false
      this.shown.push(now)
      return true
    }
  }
  return { Limiter, labels }
})
