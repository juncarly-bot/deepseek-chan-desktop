'use strict'

function buildSpeechMotionCues(text) {
  const chars = [...String(text || '')]
  const cues = []
  let lastOffset = 0
  for (let i = 0; i < chars.length; i++) {
    const strongBreak = /[。！？!?…]/.test(chars[i])
    const softBreak = /[、，,]/.test(chars[i])
    if (!strongBreak && !softBreak) continue
    const offset = i + 1
    const minGap = cues.length === 0 ? (strongBreak ? 4 : 18) : (strongBreak ? 8 : 18)
    if (offset - lastOffset < minGap) continue
    cues.push({ offset, motion: 'nod' })
    lastOffset = offset
  }
  return cues
}

const avatarMotionApi = { buildSpeechMotionCues }
if (typeof module !== 'undefined' && module.exports) module.exports = avatarMotionApi
if (typeof window !== 'undefined') window.AvatarMotion = avatarMotionApi
