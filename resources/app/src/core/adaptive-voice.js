'use strict'
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser'))
  else root.AdaptiveVoice = factory(root.TextParser)
})(typeof window === 'undefined' ? globalThis : window, function (parser) {
  const fallback = '詳しい説明は画面にまとめるね。'
  function wantsFullReading(text) {
    return /(?:全文|全て|すべて|全部|省略せず|省略しないで|最後まで).{0,24}(?:読み上げ|読んで|話して|音読)/u.test(String(text || ''))
  }
  function needsCaution(text) {
    return /物理|数学|電場|電界|磁場|力学|熱力学|量子|相対性|ガウス|マクスウェル|方程式|証明|積分|微分|数式|定理|[∫∑∂√]/u.test(String(text || ''))
  }
  class Selector {
    constructor({ cautious = false } = {}) { this.buffer = ''; this.done = false; this.cautious = cautious }
    push(delta) {
      if (this.done) return []
      this.buffer += String(delta || '')
      const end = /[。！？!?]+[」』）】)]*/u.exec(this.buffer)
      if (end) return this.select(this.buffer.slice(0, end.index + end[0].length))
      if ([...this.buffer].length > 180) return this.select('', true)
      return []
    }
    finish() { return this.done || !this.buffer.trim() ? [] : this.select(this.buffer, this.cautious) }
    select(raw, forceFallback = false) {
      this.done = true
      this.buffer = ''
      const segments = parser.parseEmotionTags(raw)
      const plain = parser.cleanText(raw)
      if (!plain && !forceFallback) return []
      const cautiousSafe = /^(?:まず|はじめに)[、\s]*(?:対称性|条件|境界条件|前提|問題文)を確認(?:しよう|してみよう|しましょう|します)[。！!]$/u.test(plain)
      const unsafe = forceFallback || (this.cautious && !cautiousSafe) || [...plain].length > 100 || /[\[\]$\\`]|[=＝∫∑∂√^{}]|https?:\/\/|\b(?:frac|sqrt)\b/u.test(plain)
      if (unsafe) return parser.buildSpeechPlan([{ emotion: segments[0]?.emotion || 'neutral', text: fallback }])
      return parser.buildSpeechPlan(segments)
    }
  }
  return { Selector, wantsFullReading, needsCaution }
})
