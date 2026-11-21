'use strict'

const PROCESS_CATEGORIES = Object.freeze({
  study_work: new Set(['code', 'cursor', 'devenv', 'pycharm64', 'idea64', 'webstorm64', 'word', 'excel', 'powerpnt', 'obsidian', 'notepad++', 'notepad', 'windowsterminal']),
  game: new Set(['valorant', 'valorant-win64-shipping', 'overwatch', 'overwatch2', 'leagueclient', 'league of legends', 'fortniteclient-win64-shipping', 'robloxplayerbeta', 'minecraft', 'javaw', 'cs2', 'dota2', 'genshinimpact', 'starrail', 'ffxiv_dx11', 'eldenring', 'apex_legends']),
  communication: new Set(['teams', 'ms-teams', 'discord', 'slack', 'zoom']),
  media: new Set(['spotify', 'vlc', 'mpv', 'obs64']),
})

function classifyProcessName(processName) {
  const normalized = String(processName || '').trim().toLowerCase().replace(/\.exe$/i, '')
  if (!normalized) return 'unknown'
  for (const [category, names] of Object.entries(PROCESS_CATEGORIES)) {
    if (names.has(normalized)) return category
  }
  return 'other'
}

function normalizeDesktopSample(sample = {}) {
  const idleMs = Number.isFinite(sample.idleMs) && sample.idleMs >= 0 ? sample.idleMs : null
  return {
    available: idleMs !== null || typeof sample.fullscreen === 'boolean' || Boolean(sample.processName),
    idleMs,
    foregroundCategory: classifyProcessName(sample.processName),
    fullscreenApp: typeof sample.fullscreen === 'boolean' ? sample.fullscreen : null,
  }
}

function unknownDesktopContext() {
  return { available:false, idleMs:null, foregroundCategory:'unknown', fullscreenApp:null }
}

function deriveDesktopPolicy(context = unknownDesktopContext()) {
  const category = context?.foregroundCategory || 'unknown'
  const longIdle = Number.isFinite(context?.idleMs) && context.idleMs >= 30 * 60 * 1000
  const fullscreen = context?.fullscreenApp === true
  const focusedWork = category === 'study_work' || category === 'game'
  const ownWindowUnavailable = context?.ownWindowState
    && (context.ownWindowState.visible === false || context.ownWindowState.minimized === true)
  return {
    suppressSpeech: longIdle || focusedWork || fullscreen || Boolean(ownWindowUnavailable),
    suppressActions: longIdle || Boolean(ownWindowUnavailable),
    preferredAction: category === 'game' ? 'nod' : category === 'study_work' ? 'think' : null,
    longIdle,
  }
}

function isUserReturning(previousIdleMs, currentIdleMs) {
  return Number.isFinite(previousIdleMs) && previousIdleMs >= 5 * 60 * 1000
    && Number.isFinite(currentIdleMs) && currentIdleMs <= 30 * 1000
}

function allowsSilentReaction({ enabled, focusMode, desktopEnabled }, context) {
  if (enabled !== true || focusMode === true) return false
  if (desktopEnabled !== true) return true
  if (!context?.available || !context.foregroundCategory || context.foregroundCategory === 'unknown' || typeof context.fullscreenApp !== 'boolean') return false
  return !deriveDesktopPolicy(context).suppressSpeech
}

module.exports = { classifyProcessName, normalizeDesktopSample, unknownDesktopContext,
  deriveDesktopPolicy, isUserReturning, allowsSilentReaction }
