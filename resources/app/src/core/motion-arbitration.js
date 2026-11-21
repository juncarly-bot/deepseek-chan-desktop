'use strict'
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.MotionArbitration = factory()
})(typeof window === 'undefined' ? globalThis : window, function () {
  const rank = Object.freeze({ idle:1, autonomy:2, reaction:3, thinking:3, filler:4, speech:4, manual:4 })
  const axes = Object.freeze({ ParamAngleX:30, ParamAngleY:30, ParamAngleZ:30,
    ParamBodyAngleX:10, ParamBodyAngleY:10, ParamBodyAngleZ:10 })
  function allows(source, state, audioPlaying) {
    if (source === 'autonomy') return state === 'idle' && !audioPlaying
    if (source === 'thinking') return (state === 'thinking' || state === 'listening') && !audioPlaying
    if (source === 'reaction') return !audioPlaying && state !== 'speaking'
    return true
  }
  function canReplace(current, incoming) { return (rank[incoming] || 0) >= (rank[current] || 0) }
  class Arbiter {
    constructor(seed = null) { this.pose = seed ? { ...seed } : null; this.generation = null }
    begin(id) { this.generation = id }
    isCurrent(id) { return Boolean(id) && id === this.generation }
    cancel(id) { if (!id || id === this.generation) { this.generation = null; return true } return false }
    smooth(target, dt) {
      if (!this.pose) this.pose = { ...target }
      const follow = 1 - Math.exp(-Math.max(0, Math.min(0.1, Number(dt) || 0)) * 7)
      const result = { ...target }
      for (const [axis, limit] of Object.entries(axes)) {
        const desired = Math.max(-limit, Math.min(limit, Number(target[axis]) || 0))
        const seeded = Number.isFinite(this.pose[axis]) ? this.pose[axis] : desired
        const previous = Math.max(-limit, Math.min(limit, seeded))
        result[axis] = previous + (desired - previous) * follow
      }
      this.pose = result
      return result
    }
  }
  return { Arbiter, allows, canReplace }
})
