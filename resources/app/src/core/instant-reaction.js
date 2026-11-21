'use strict'
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.InstantReaction = factory()
})(typeof window === 'undefined' ? globalThis : window, function () {
  class Controller {
    constructor({ setState, random = Math.random, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) }) {
      this.setState = setState
      this.random = random
      this.schedule = schedule
      this.cancel = cancel
      this.serial = 0
      this.timer = null
      this.phase = 'idle'
    }
    begin() {
      this.clearTimer()
      const token = ++this.serial
      this.phase = 'listening'
      this.setState('listening')
      const delay = 420 + Math.floor(Math.max(0, Math.min(1, this.random())) * 160)
      this.timer = this.schedule(() => {
        if (token !== this.serial || this.phase !== 'listening') return
        this.timer = null
        this.phase = 'thinking'
        this.setState('thinking')
      }, delay)
      return token
    }
    current(token) { return token === this.serial }
    transition(state) {
      if (state === 'thinking' && this.phase === 'listening') return
      this.clearTimer()
      this.phase = state
      this.setState(state === 'interrupted' ? 'idle' : state)
    }
    invalidate() { this.clearTimer(); ++this.serial; this.phase = 'interrupted'; this.setState('idle') }
    clearTimer() { if (this.timer !== null) this.cancel(this.timer); this.timer = null }
  }
  return { Controller }
})
