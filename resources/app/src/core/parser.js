'use strict'
/**
 * parser.js — DeepSeekちゃんの応答テキスト処理
 *
 * AITuberKit のプリセット形式に合わせ、応答中の感情タグ [happy] と
 * モーションタグ [motion:wave] を解析する。タグは表示・読み上げからは除去し、
 * 表情・モーション制御にだけ使う。
 */

// 15 canonical emotions plus legacy aliases kept readable for saved prompts/history.
const CANONICAL_EMOTIONS = ['neutral', 'happy', 'shy', 'excited', 'thinking', 'sleepy', 'proud', 'sad', 'annoyed', 'surprised', 'greeting', 'playful', 'flustered', 'confused', 'pout']
const LEGACY_EMOTIONS = ['angry', 'relaxed', 'worried', 'loving', 'crying']
const EMOTIONS = [...CANONICAL_EMOTIONS, ...LEGACY_EMOTIONS]
const MOTIONS = [
  'think',
  'cheer',
  'bow',
  'shy',
  // Kept parseable for saved replies; the Live2D controller intentionally ignores hand gestures.
  'wave',
]

// Match even unknown tags so they cannot leak into the chat or TTS text.
const TAG_RE = /\[(?:motion:([a-z_]+)|([a-z_]+)(?::(\d+(?:\.\d+)?))?)\]/gi

/**
 * タグ付きテキストを { emotion, motion, text } のセグメント列に分解する。
 * @param {string} text
 * @returns {{emotion:string, motion:(string|null), text:string}[]}
 */
function parseEmotionTags(text) {
  const segments = []
  let emotion = 'neutral'
  let intensity = null
  let motion = null
  let last = 0
  let buf = ''
  const src = String(text || '')
  TAG_RE.lastIndex = 0
  let m
  const flush = () => {
    const t = buf.trim()
    if (t) {
      const segment = { emotion, motion, text: t }
      if (intensity !== null) segment.intensity = intensity
      segments.push(segment)
    }
    buf = ''
  }
  while ((m = TAG_RE.exec(src)) !== null) {
    buf += src.slice(last, m.index)
    last = m.index + m[0].length
    if (m[1]) {
      flush()
      motion = MOTIONS.includes(m[1]) ? m[1] : null
    } else if (m[2]) {
      flush()
      const requested = m[2].toLowerCase()
      emotion = EMOTIONS.includes(requested) ? requested : 'neutral'
      intensity = EMOTIONS.includes(requested) && m[3] !== undefined ? Math.max(0, Math.min(1, Number(m[3]))) : null
    }
  }
  buf += src.slice(last)
  flush()
  // モーションは最初のセグメントにだけ付ける（連続発火を防ぐ）
  let motionUsed = false
  for (const s of segments) {
    if (s.motion && !motionUsed) motionUsed = true
    else if (s.motion) s.motion = null
  }
  return segments
}

/** 表示・読み上げ用にタグを取り除く */
function cleanText(text) {
  return String(text || '')
    .replace(TAG_RE, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * TTS キュー用に文単位へ分割する（句読点・改行で区切る）。
 * 長すぎる文は読点でも割る。
 */
function splitSentences(text, maxLen = 90) {
  const cleaned = cleanText(text)
  if (!cleaned) return []
  const raw = cleaned
    .split(/(?<=[。！？!?…])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const s of raw) {
    if (s.length <= maxLen) {
      out.push(s)
      continue
    }
    let rest = s
    while (rest.length > maxLen) {
      const cut = Math.max(rest.lastIndexOf('、', maxLen), rest.lastIndexOf(' ', maxLen))
      let idx = cut > 20 ? cut + 1 : maxLen
      if (idx < rest.length && /[\uD800-\uDBFF]/.test(rest[idx - 1]) && /[\uDC00-\uDFFF]/.test(rest[idx])) idx--
      out.push(rest.slice(0, idx).trim())
      rest = rest.slice(idx).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}

/** 音声サーバーの長さ制限までは返答を一続きにまとめる。 */
function buildSpeechPlan(segments, maxLength = 300) {
  const plans = []
  let current = null
  const flush = () => { if (current?.text) plans.push(current); current = null }
  for (const segment of segments || []) {
    const text = cleanText(segment.text || '')
    if (!text) continue
    const pieces = text.length > maxLength ? splitSentences(text, Math.min(260, maxLength)) : [text]
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      let separator = current && /[A-Za-z0-9]$/.test(current.text) && /^[A-Za-z0-9]/.test(piece) ? ' ' : ''
      if (current && current.text.length + separator.length + piece.length > maxLength) { flush(); separator = '' }
      if (!current) current = { text: '', cues: [] }
      current.text += separator
      current.cues.push({ offset: [...current.text].length, emotion: segment.emotion || 'neutral',
        intensity: segment.intensity, motion: i === 0 ? segment.motion : null })
      current.text += piece
    }
  }
  flush()
  return plans
}

const parserApi = { EMOTIONS, CANONICAL_EMOTIONS, MOTIONS, parseEmotionTags, cleanText, splitSentences, buildSpeechPlan }
if (typeof module !== 'undefined' && module.exports) module.exports = parserApi
if (typeof window !== 'undefined') window.TextParser = parserApi
