'use strict'

;(function () {
const parser = typeof module !== 'undefined' && module.exports
  ? require('./parser')
  : window.TextParser
const { parseEmotionTags, buildSpeechPlan } = parser

/** Incrementally turns completed Japanese sentences into ordered TTS plans. */
class StreamingSpeechChunker {
  constructor({ maxLength = 300 } = {}) {
    this.maxLength = Math.max(40, Math.min(300, Number(maxLength) || 300))
    this.buffer = ''
    this.emotion = 'neutral'
    this.intensity = null
  }

  push(delta) {
    this.buffer += String(delta || '')
    return this.drain(false)
  }

  finish() {
    return this.drain(true)
  }

  drain(final) {
    const plans = []
    const sentenceEnd = /[。！？!?]+[」』）】)]*/
    for (;;) {
      const match = sentenceEnd.exec(this.buffer)
      if (!match) break
      const end = match.index + match[0].length
      const sentence = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end)
      plans.push(...this.toPlans(sentence))
    }
    if (final && this.buffer.trim()) {
      plans.push(...this.toPlans(this.buffer))
      this.buffer = ''
    }
    return plans
  }

  toPlans(sentence) {
    const carryTag = `[${this.emotion}${this.intensity === null ? '' : `:${this.intensity}`}]`
    const segments = parseEmotionTags(carryTag + sentence)
    const last = segments.at(-1)
    if (last) {
      this.emotion = last.emotion || 'neutral'
      this.intensity = last.intensity ?? null
    }
    return buildSpeechPlan(segments, this.maxLength)
  }
}

const streamingSpeechApi = { StreamingSpeechChunker }
if (typeof module !== 'undefined' && module.exports) module.exports = streamingSpeechApi
if (typeof window !== 'undefined') window.StreamingSpeech = streamingSpeechApi
})()
