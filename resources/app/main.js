'use strict'
/**
 * main.js — DeepSeekちゃん デスクトップアプリ（Electron メインプロセス）
 *
 * 役割:
 * - 透過・フレームレス・最前面のデスクトップ常駐ウィンドウ＋トレイ
 * - DeepSeek API / VOICEVOX への通信（APIキーはこのプロセス内でのみ保持）
 * - 設定・会話履歴の永続化（userData 配下）
 * - プラグインホスト（自発発話などの拡張）
 *
 * APIキーの解決順: 環境変数 DEEPSEEK_API_KEY → userData/.env → アプリ直下の .env
 * キーをコードや settings.json に保存することはしない。
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, dialog } = require('electron')
const fs = require('fs')
const path = require('path')

const { createDeepSeekClient } = require('./src/core/deepseek')
const { createVoicevoxClient } = require('./src/core/voicevox')
const { createQwenTtsClient } = require('./src/core/qwen-tts')
const { HistoryStore } = require('./src/core/history')
const { LongTermMemoryStore, extractCandidates } = require('./src/core/long-term-memory')
const { FollowUpScheduler, followUpText, MIN_IDLE_MS, START_DELAY_MS } = require('./src/core/proactive-followups')
const { CalendarStore, zonedDateTimeToIso } = require('./src/core/calendar-store')
const { CalendarPresenceManager, DEFAULT_CALENDAR_PRESENCE, buildBriefing } = require('./src/core/calendar-presence')
const { Conversation } = require('./src/core/conversation')
const { PluginHost } = require('./src/core/plugins')
const config = require('./src/core/config')
const { createPerformanceMetrics } = require('./src/core/performance-metrics')
const { appendBoundedLog } = require('./src/core/rotating-log')
const { AutonomyGuard, canRunAutonomousAction } = require('./src/core/autonomy')
const { createWindowsDesktopContextReader } = require('./src/core/windows-desktop-context')
const { unknownDesktopContext, deriveDesktopPolicy, isUserReturning, allowsSilentReaction } = require('./src/core/desktop-context')

const IS_DEV = !app.isPackaged
const APP_DIR = __dirname
const { spawn } = require('child_process')
const IS_ELECTRON_E2E = process.env.DEEPSEEK_E2E === '1'
if (process.env.DEEPSEEK_QA_DATA) app.setPath('userData', process.env.DEEPSEEK_QA_DATA)
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
let qwenProcess = null
let qwenStarting = null
const FAST_URL = IS_ELECTRON_E2E ? 'http://127.0.0.1:9' : 'http://127.0.0.1:18765'
const FAST_SERVICE = 'deepseek-voice-a-fast-v1'
async function fastStatus() {
  try {
    const res = await fetch(`${FAST_URL}/health`, {signal: AbortSignal.timeout(2500)})
    const data = await res.json()
    if (data.service !== FAST_SERVICE) return {available:false, status:'conflict'}
    return {available:res.ok && data.ok === true, status:data.status || 'loading',
      voice:data.voice || 'unknown', sampleRate:data.sampleRate || 24000,
      voiceFingerprint:typeof data.referenceSha256 === 'string' ? data.referenceSha256 : null}
  } catch { return {available:false, status:'offline'} }
}
async function ensureLocalQwen() {
  if (process.env.DEEPSEEK_SKIP_QWEN === '1' || qwenProcess) return
  if (qwenStarting) return qwenStarting
  qwenStarting = (async () => {
    const current = await fastStatus()
    if (current.status !== 'offline') return
    const root = path.resolve(APP_DIR, '..', '..')
    const python = path.join(root, 'qwen-runtime', 'native-venv', 'Scripts', 'python.exe')
    const script = path.join(root, 'scripts', 'qwen-fast-server.py')
    const home = path.join(root, 'qwen-runtime', 'python')
    const configFile = path.join(root, 'qwen-runtime', 'native-venv', 'pyvenv.cfg')
    if (!fs.existsSync(python) || !fs.existsSync(script)) throw new Error('高速音声エンジンが見つかりません')
    const configText = fs.readFileSync(configFile, 'utf8')
    const updated = configText.replace(/^home\s*=.*$/m, `home = ${home}`)
    if (updated !== configText) fs.writeFileSync(configFile, updated, 'utf8')
    const fd = fs.openSync(userFile('voice-a-fast.log'), 'a')
    try {
      qwenProcess = spawn(python, ['-u', script, '--owner-pid', String(process.pid)], {
        windowsHide: true, cwd: root,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', fd, fd],
      })
    } finally { fs.closeSync(fd) }
    qwenProcess.on('error', e => logLaunch('[fast-voice] failed:', e.message))
    qwenProcess.on('exit', () => { qwenProcess = null })
  })()
  try { await qwenStarting } finally { qwenStarting = null }
}

// 通常は GPU で描画し、GPU 起動に失敗した場合は次回から互換モードに戻す。
const gpuFallbackFlag = path.join(app.getPath('userData'), 'live2d-software-render.flag')
const softwareRendering = process.env.DEEPSEEK_SOFTWARE_RENDER === '1' || fs.existsSync(gpuFallbackFlag)
try {
  if (softwareRendering) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  }
} catch {}

// 起動ログ（userData/launch.log）。起動できないときの切り分け用。
const LAUNCH_LOG = (() => {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'launch.log')
  } catch {
    return null
  }
})()
function logLaunch(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')}`
  appendBoundedLog(LAUNCH_LOG, line)
}
// A desktop launch may outlive the shell that started it. A closed output pipe
// must not turn diagnostics into an endless uncaught-exception loop.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', () => {})
}
process.on('uncaughtException', (e) => logLaunch('[fatal] uncaughtException:', e))
process.on('unhandledRejection', (e) => logLaunch('[fatal] unhandledRejection:', e))
app.on('child-process-gone', (_e, details) => {
  logLaunch('[child-process-gone]', JSON.stringify(details))
  if (!softwareRendering && details.type === 'GPU' && ['crashed', 'launch-failed'].includes(details.reason)) {
    try {
      fs.writeFileSync(gpuFallbackFlag, 'GPU acceleration failed; using software rendering.\n')
      app.relaunch()
      app.exit(0)
    } catch (e) { logLaunch('[gpu-fallback]', e) }
  }
})
logLaunch('=== launch === platform:', process.platform, 'electron:', process.versions.electron)

let win = null
let tray = null
let settings = null
let history = null
let longTermMemory = null
let followUpScheduler = null
let calendarStore = null
let calendarPresence = null
let calendarPresenceStartedAt = Date.now()
let calendarPresenceE2EState = null
let activeCalendarNotice = null
let calendarNoticeTimeout = null
let proactiveSpeechGenerationId = null
let conversation = null
const chatRequests = new Map()
let voicevox = null
let qwenTts = null
let pluginHost = null
let lastActivityAt = Date.now()
let windowMode = 'pet' // 'pet' | 'full'
let recreateTried = false
let performanceMetrics = null
const autonomyGuard = new AutonomyGuard()
const autonomyBudgetFile = userFile('autonomy-budget.json')
try {
  const state = JSON.parse(fs.readFileSync(autonomyBudgetFile, 'utf8'))
  if (state?.version === 1) autonomyGuard.restoreState(state.speechStarts)
} catch {}
const autonomousActions = ['nod', 'think', 'shy', 'cheer', 'bow']
let lastAutonomousActionAt = Date.now()
let autonomyRunController = null
let autonomyRunInFlight = false
const rendererPresence = { chatting:false, speaking:false, listening:false }
const PRESENCE_DAY_MS = 24 * 60 * 60 * 1000
let nextAutonomousAction = 0
const readWindowsDesktopContext = createWindowsDesktopContextReader()
let desktopContextCache = unknownDesktopContext()
let desktopContextSampledAt = 0
let previousDesktopIdleMs = null
let desktopContextReadInFlight = null
let desktopContextPermissionGeneration = 0
let desktopContextAbortController = null
let e2eDesktopSample = null

function setRendererPresence(patch) {
  for (const key of Object.keys(rendererPresence)) {
    if (typeof patch?.[key] === 'boolean') rendererPresence[key] = patch[key]
  }
}

function noteUserActivity() {
  lastActivityAt = Date.now()
  autonomyRunController?.abort()
  if (proactiveSpeechGenerationId) {
    const generationId = proactiveSpeechGenerationId
    proactiveSpeechGenerationId = null
    autonomyGuard.finishSpeech()
    autonomyRunInFlight = false
    persistAutonomyBudget()
    if (win && !win.isDestroyed()) win.webContents.send('proactive:cancel', generationId)
  }
}

function isAutonomyBusy() {
  return rendererPresence.chatting || rendererPresence.speaking || rendererPresence.listening
    || autonomyRunInFlight || chatRequests.size > 0 || Boolean(activeCalendarNotice)
}

async function checkAutonomy(now = Date.now()) {
  if (!settings || !pluginHost || !win || win.isDestroyed()) return 'blocked'
  const desktopContext = await getDesktopContext(now)
  const desktopPolicy = deriveDesktopPolicy(desktopContext)
  const idleForMs = now - lastActivityAt
  const busy = isAutonomyBusy()
  const focusMode = settings.autonomy?.focusMode === true || win.isFullScreen()
  const calendarConfig = { ...DEFAULT_CALENDAR_PRESENCE, ...(settings.calendarPresence || {}),
    quietHours:{ ...DEFAULT_CALENDAR_PRESENCE.quietHours, ...(settings.calendarPresence?.quietHours || {}) } }
  const presenceEnabled = ['briefingEnabled','classQuietEnabled','deadlineRemindersEnabled','examRemindersEnabled',
    'eventRemindersEnabled','automaticFollowUpsEnabled','studyRivalEnabled'].some(key=>calendarConfig[key]===true)
  const nearbyEvents = calendarStore && presenceEnabled ? CalendarPresenceManager.reminderEvents(calendarStore, now) : []
  const classQuiet = calendarPresence?.classQuiet(nearbyEvents, calendarConfig, now) === true
  if (classQuiet) return 'class-quiet'
  const calendarResult = await checkCalendarPresence({ now, idleForMs, busy, focusMode, desktopContext, desktopPolicy,
    nearbyEvents, calendarConfig })
  if (calendarResult !== 'blocked') return calendarResult
  const proactiveResult = await checkProactiveFollowUp({ now, idleForMs, busy, focusMode, desktopContext, desktopPolicy })
  if (proactiveResult !== 'blocked') return proactiveResult
  const actionIntervalMs = Math.max(1, Math.min(60, Number(settings.autonomy?.actionIntervalMinutes) || 5)) * 60 * 1000
  const returning = isUserReturning(previousDesktopIdleMs, desktopContext.idleMs)
  previousDesktopIdleMs = desktopContext.idleMs
  if (returning && !desktopPolicy.suppressActions && settings.autonomy?.actionsEnabled === true
      && !focusMode && !busy && desktopContext.fullscreenApp !== true) {
    lastAutonomousActionAt = now
    await pluginHost.emit('autonomyAction', { action:'nod' })
    return 'return-reaction'
  }
  if (!desktopPolicy.suppressActions && now - lastAutonomousActionAt >= actionIntervalMs && canRunAutonomousAction({
    enabled:settings.autonomy?.actionsEnabled === true,
    focusMode, busy, idleForMs, idleThresholdMs:actionIntervalMs,
  })) {
    const action = desktopPolicy.preferredAction || autonomousActions[nextAutonomousAction++ % autonomousActions.length]
    lastAutonomousActionAt = now
    await pluginHost.emit('autonomyAction', { action })
    return 'action'
  }

  const idleThresholdMs = Math.max(5, Math.min(240, Number(settings.idleTalk?.intervalMinutes) || 15)) * 60 * 1000
  const eligible = autonomyGuard.canSpeak({
    enabled:settings.idleTalk?.enabled === true,
    voiceEnabled:settings.voice?.enabled === true,
    focusMode:focusMode || desktopPolicy.suppressSpeech, busy, idleForMs, idleThresholdMs, now,
  })
  if (!eligible || !autonomyGuard.beginSpeech(now)) return 'blocked'
  if (!persistAutonomyBudget(now)) {
    autonomyGuard.finishSpeech()
    lastActivityAt = now
    return 'blocked'
  }
  noteUserActivity()
  autonomyRunInFlight = true
  const controller = new AbortController()
  autonomyRunController = controller
  await pluginHost.emit('idle', { signal:controller.signal }).catch(() => {}).finally(() => {
    if (autonomyRunController === controller) autonomyRunController = null
    autonomyRunInFlight = false
    autonomyGuard.finishSpeech()
  })
  return controller.signal.aborted ? 'cancelled' : 'speech'
}

async function checkProactiveFollowUp({ now = Date.now(), idleForMs = 0, busy = false, focusMode = false,
  desktopContext = unknownDesktopContext(), testMode = false } = {}) {
  if (!settings?.proactive?.followUpsEnabled || settings.memory?.longTermEnabled !== true
      || !followUpScheduler || !longTermMemory || !win || win.isDestroyed()) return 'blocked'
  if (proactiveNoticeCount(now) >= Math.min(2, Number(settings.proactive?.dailyMax) || 2)) return 'blocked'
  const candidate = followUpScheduler.selectCandidate(longTermMemory.list(), {
    now, config:settings.proactive, idleForMs, busy,
    focusMode:focusMode || settings.autonomy?.focusMode === true,
    fullscreen:!testMode && win.isFullScreen(),
    windowAvailable:testMode || (win.isVisible() && !win.isMinimized()),
    desktopContextEnabled:settings.desktopContext?.enabled === true,
    desktopContext,
  })
  if (!candidate) return 'blocked'
  const mode = settings.proactive.delivery === 'voice' ? 'voice' : 'bubble'
  const text = followUpText(candidate.item)
  if (!text) return 'blocked'
  {
    const canSpeak = autonomyGuard.canSpeak({
      enabled:settings.proactive.followUpsEnabled === true,
      // Bubbles and voice share the same local proactive notification budget.
      voiceEnabled:mode === 'bubble' || settings.voice?.enabled === true,
      focusMode:focusMode || settings.autonomy?.focusMode === true || (!testMode && win.isFullScreen()),
      busy:busy || isAutonomyBusy(), idleForMs, idleThresholdMs:MIN_IDLE_MS, now,
    })
    if (!canSpeak || !autonomyGuard.beginSpeech(now)) return 'blocked'
    if (!persistAutonomyBudget(now)) { autonomyGuard.finishSpeech(); return 'blocked' }
  }
  try {
    if (!followUpScheduler.recordDelivery(candidate.item, mode, now)) {
      autonomyGuard.finishSpeech(); persistAutonomyBudget(now)
      return 'blocked'
    }
  } catch (error) {
    autonomyGuard.finishSpeech(); persistAutonomyBudget(now)
    logLaunch('[follow-up] state save failed:', error.message)
    return 'blocked'
  }
  win.webContents.send('proactive:follow-up', { memoryId:candidate.item.id, text, mode })
  if (mode === 'voice') {
    const generationId = require('node:crypto').randomUUID()
    proactiveSpeechGenerationId = generationId
    autonomyRunInFlight = true
    win.webContents.send('speech:say', { text, segments:[{ text, emotion:'neutral', motion:'think' }], generationId, proactive:true })
  }
  if (mode === 'bubble') { autonomyGuard.finishSpeech(); persistAutonomyBudget(now) }
  return mode === 'voice' ? 'follow-up-voice' : 'follow-up-bubble'
}

async function checkCalendarPresence({ now, idleForMs, busy, focusMode, desktopContext, desktopPolicy, nearbyEvents, calendarConfig } = {}) {
  if (!calendarPresence || !calendarStore || activeCalendarNotice || calendarConfig.classQuietEnabled && calendarPresence.classQuiet(nearbyEvents,calendarConfig,now)) return 'blocked'
  const desktopUnknown=settings.desktopContext?.enabled===true && (!desktopContext?.available
    || desktopContext.foregroundCategory==='unknown' || typeof desktopContext.fullscreenApp!=='boolean')
  if (calendarPresenceStartedAt + 2*60_000 > now || busy || focusMode || win?.isFullScreen()
      || !win?.isVisible() || win?.isMinimized() || desktopPolicy?.suppressSpeech
      || desktopUnknown
      || !Number.isFinite(idleForMs) || idleForMs < MIN_IDLE_MS || calendarPresence.isPaused(now)) return 'blocked'
  const history=calendarPresence.history()
  if (!history.writable || followUpScheduler?.writable===false
      || proactiveNoticeCount(now) >= 2) return 'blocked'
  const limit = autonomyGuard.canSpeak({ enabled:true, voiceEnabled:true, focusMode:false, busy:false,
    idleForMs, idleThresholdMs:MIN_IDLE_MS, now })
  if (!limit) return 'blocked'
  const summary=calendarStore.summary(now)
  const memories=calendarConfig.automaticFollowUpsEnabled && settings.memory?.longTermEnabled===true
    ? longTermMemory?.list({skipExpiry:true}) || [] : []
  const candidate=calendarPresence.candidates(nearbyEvents,summary,calendarConfig,now).find(item=>{
    if (item.kind!=='exam-followup' || !item.linkedMemoryId) return true
    const linked=memories.find(memory=>memory.id===item.linkedMemoryId)
    return !linked || !['completed','cancelled','expired','superseded'].includes(linked.status)
  })
  if (!candidate) return 'blocked'
  const voiceAllowed=calendarConfig.voiceEnabled === true && settings.voice?.enabled === true
    && (settings.qwen?.mode !== 'cloud' || calendarConfig.allowCloudVoice === true)
  const delivery=voiceAllowed?'voice':'bubble'
  if (!autonomyGuard.beginSpeech(now)) return 'blocked'
  if (!persistAutonomyBudget(now)) { autonomyGuard.finishSpeech(); return 'blocked' }
  try {
    if (!calendarPresence.record(candidate,now)) { autonomyGuard.finishSpeech(); persistAutonomyBudget(now); return 'blocked' }
    activeCalendarNotice={ ...candidate, delivery, at:now }
    if (calendarNoticeTimeout) clearTimeout(calendarNoticeTimeout)
    calendarNoticeTimeout=setTimeout(()=>{
      if (activeCalendarNotice?.delivery==='voice' && proactiveSpeechGenerationId) {
        const staleId=proactiveSpeechGenerationId
        proactiveSpeechGenerationId=null; autonomyGuard.finishSpeech(); autonomyRunInFlight=false; persistAutonomyBudget()
        if (win && !win.isDestroyed()) win.webContents.send('proactive:cancel',staleId)
      }
      activeCalendarNotice=null; calendarNoticeTimeout=null
    },90_000)
    calendarNoticeTimeout.unref?.()
    win.webContents.send('calendar-presence:notice', { key:candidate.key, kind:candidate.kind, eventId:candidate.eventId,
      text:candidate.text, delivery, at:now })
    if (delivery === 'voice') {
      const generationId=require('node:crypto').randomUUID()
      proactiveSpeechGenerationId=generationId
      autonomyRunInFlight=true
      win.webContents.send('speech:say',{ text:candidate.text, segments:[{text:candidate.text,emotion:'neutral',motion:'think'}], generationId, proactive:true, calendarPresence:true })
    } else { autonomyGuard.finishSpeech(); persistAutonomyBudget(now) }
    return `calendar-${candidate.kind}`
  } catch(error) {
    autonomyGuard.finishSpeech(); persistAutonomyBudget(now)
    logLaunch('[calendar-presence] local notification failed:',error.message)
    return 'blocked'
  }
}

function proactiveNoticeCount(now=Date.now()) {
  return (followUpScheduler?.status(longTermMemory?.list({skipExpiry:true}) || []).todayCount || 0)
    + (calendarPresence?.history().countToday || 0)
}

async function respondToCalendarPresence(payload = {}) {
  const item=activeCalendarNotice
  if (!item || !calendarPresence || String(payload.key||'') !== item.key || !['completed','later','rest','mute','start','dismiss'].includes(payload.action)) return {ok:false,error:'通知が見つかりません'}
  const action=payload.action==='start'?'later':payload.action
  try {
    if (!calendarPresence.respond(item,action,Date.now())) return {ok:false,error:'通知の状態を保存できません'}
    if (payload.action==='completed' && item.eventId && item.kind==='deadline') {
      const eventId=String(item.eventId).split('::')[0]
      const event=calendarStore?.get(eventId)
      if (event?.category==='assignment') {
        const patch={ taskStatus:'completed', completed:true }
        if (String(item.eventId).includes('::') && event.recurrence) calendarStore.updateOccurrence(item.eventId,patch)
        else calendarStore.update(eventId,patch)
      }
    }
    if (payload.action==='completed' && item.linkedMemoryId && item.kind!=='study'
        && longTermMemory && settings.memory?.longTermEnabled===true) {
      const memory=longTermMemory.list({skipExpiry:true}).find(row=>row.id===item.linkedMemoryId)
      if (memory && ['open_loop','commitment'].includes(memory.type)) longTermMemory.update(memory.id,{status:'completed',followUpAt:null})
    }
    activeCalendarNotice=null
    if (calendarNoticeTimeout) clearTimeout(calendarNoticeTimeout)
    calendarNoticeTimeout=null
    return {ok:true}
  } catch(error) { return {ok:false,error:String(error?.message||'状態を更新できません').slice(0,160)} }
}

function clearCalendarNoticeForEvent(eventId, occurrenceOnly=false) {
  if (!activeCalendarNotice?.eventId) return
  const target=String(eventId||''), current=String(activeCalendarNotice.eventId)
  if (current!==target && (occurrenceOnly || !current.startsWith(`${target}::`))) return
  const key=activeCalendarNotice.key
  if (activeCalendarNotice.delivery==='voice' && proactiveSpeechGenerationId) {
    const generationId=proactiveSpeechGenerationId
    proactiveSpeechGenerationId=null; autonomyGuard.finishSpeech(); autonomyRunInFlight=false; persistAutonomyBudget()
    if (win && !win.isDestroyed()) win.webContents.send('proactive:cancel',generationId)
  }
  activeCalendarNotice=null
  if (calendarNoticeTimeout) clearTimeout(calendarNoticeTimeout)
  calendarNoticeTimeout=null
  if (win && !win.isDestroyed()) win.webContents.send('calendar-presence:clear',{key})
}

function finishCalendarPresenceE2EState() {
  const state=calendarPresenceE2EState
  if (!state) return
  for (const id of state.added) { try { calendarStore.delete(id) } catch {} }
  const noticeEventId=String(activeCalendarNotice?.eventId||'').split('::')[0]
  if (noticeEventId && state.added.includes(noticeEventId)) {
    const key=activeCalendarNotice.key
    activeCalendarNotice=null
    if (calendarNoticeTimeout) clearTimeout(calendarNoticeTimeout)
    calendarNoticeTimeout=null
    if (win && !win.isDestroyed()) win.webContents.send('calendar-presence:clear',{key})
  }
  const original=state.original
  settings.calendarPresence=original.calendarPresence
  settings.autonomy.focusMode=original.focusMode; settings.desktopContext.enabled=original.desktopEnabled
  calendarPresenceStartedAt=original.calendarPresenceStartedAt; lastActivityAt=original.lastActivityAt
  lastAutonomousActionAt=original.lastAutonomousActionAt; desktopContextCache=original.desktopContextCache
  desktopContextSampledAt=original.desktopContextSampledAt
  autonomyGuard.lastSpeechAt=original.speechLastAt; autonomyGuard.speechStarts=original.speechStarts
  autonomyGuard.speechInFlight=original.speechInFlight; setRendererPresence(original.presence)
  if (!original.visible && win && !win.isDestroyed()) win.hide()
  calendarPresenceE2EState=null
}

async function getDesktopContext(now = Date.now()) {
  if (settings?.desktopContext?.enabled !== true) {
    desktopContextCache = unknownDesktopContext()
    previousDesktopIdleMs = null
    return desktopContextCache
  }
  if (desktopContextReadInFlight) return desktopContextReadInFlight
  if (now - desktopContextSampledAt < 30_000) return desktopContextCache
  const permissionGeneration = desktopContextPermissionGeneration
  const abortController = new AbortController()
  desktopContextAbortController = abortController
  const pending = (async () => {
    try {
      const context = IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_DESKTOP === '1' && e2eDesktopSample
        ? require('./src/core/desktop-context').normalizeDesktopSample(e2eDesktopSample)
        : await readWindowsDesktopContext({ signal:abortController.signal })
      if (permissionGeneration !== desktopContextPermissionGeneration || settings?.desktopContext?.enabled !== true) {
        desktopContextCache = unknownDesktopContext()
        return desktopContextCache
      }
      desktopContextCache = {
        ...context,
        ownWindowState:IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_DESKTOP === '1'
          ? { visible:true, minimized:false, fullscreen:false, focused:true }
          : win && !win.isDestroyed() ? {
          visible:win.isVisible(), minimized:win.isMinimized(), fullscreen:win.isFullScreen(), focused:win.isFocused(),
        } : null,
      }
    } catch {
      desktopContextCache = unknownDesktopContext()
    } finally {
      desktopContextSampledAt = now
    }
    return desktopContextCache
  })()
  desktopContextReadInFlight = pending
  try { return await pending } finally {
    if (desktopContextReadInFlight === pending) desktopContextReadInFlight = null
    if (desktopContextAbortController === abortController) desktopContextAbortController = null
  }
}

function recordPerformanceMetric(event, values = {}) {
  try {
    if (!performanceMetrics) performanceMetrics = createPerformanceMetrics({ filePath: userFile('live-presence-metrics.jsonl') })
    return performanceMetrics.record(event, values)
  } catch { return false }
}

function sampleProcessPerformance() {
  try {
    const samples = app.getAppMetrics()
    const cpuPercent = samples.reduce((sum, item) => sum + (Number(item.cpu?.percentCPUUsage) || 0), 0)
    const workingSetMB = samples.reduce((sum, item) => sum + (Number(item.memory?.workingSetSize) || 0), 0) / 1024
    recordPerformanceMetric('process.sample', { cpuPercent, workingSetMB, processCount: samples.length })
  } catch {}
}

function userFile(name) {
  return path.join(app.getPath('userData'), name)
}

function persistAutonomyBudget(now = Date.now()) {
  const tempFile = `${autonomyBudgetFile}.${process.pid}.${now}.tmp`
  try {
    fs.writeFileSync(tempFile, JSON.stringify(autonomyGuard.snapshot(now)), { encoding:'utf8', mode:0o600 })
    fs.renameSync(tempFile, autonomyBudgetFile)
    return true
  } catch (error) {
    try { fs.unlinkSync(tempFile) } catch {}
    logLaunch('[autonomy] speech limit state could not be saved:', error.message)
    return false
  }
}

function resolveApiKey() {
  // userData/.env を最優先の「入力場所」とし、開発時はアプリ直下 .env も見る
  const fromUser = config.resolveApiKey(userFile('.env'), {})
  if (fromUser) return fromUser
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  return config.resolveApiKey(path.join(APP_DIR, '.env'), {})
}

function writeUserEnvVar(name, value) {
  const file = userFile('.env')
  let lines = []
  try {
    lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
  } catch {
    lines = []
  }
  lines = lines.filter((l) => !l.trim().startsWith(`${name}=`))
  if (value) lines.push(`${name}=${value}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.filter((l) => l !== '').join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
}

function writeUserEnvKey(key) {
  writeUserEnvVar('DEEPSEEK_API_KEY', key)
}

function resolveDashscopeKey() {
  try {
    const fromUser = config.parseEnv(fs.readFileSync(userFile('.env'), 'utf-8')).DASHSCOPE_API_KEY
    if (fromUser) return fromUser
  } catch {}
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  try {
    return config.parseEnv(fs.readFileSync(path.join(APP_DIR, '.env'), 'utf-8')).DASHSCOPE_API_KEY || ''
  } catch {
    return ''
  }
}

function reloadRuntime() {
  const apiKey = resolveApiKey()
  const deepseek = createDeepSeekClient({
    apiKey,
    baseUrl: settings.ai.baseUrl,
    model: settings.ai.model,
    thinkingMode: settings.ai.thinkingMode,
  })
  voicevox = createVoicevoxClient({ baseUrl: settings.voice.serverUrl })
  qwenTts = createQwenTtsClient({
    mode: settings.qwen.mode,
    serverUrl: settings.qwen.serverUrl,
    cloudBaseUrl: settings.qwen.cloudBaseUrl,
    model: settings.qwen.model,
    speaker: settings.qwen.speaker,
    language: settings.qwen.language,
    instruct: settings.qwen.instruct,
    apiKey: resolveDashscopeKey(),
  })
  if (!history) history = new HistoryStore(userFile('chat-history.json'))
  conversation = new Conversation({ deepseek, history, settings, memory:longTermMemory })
  conversation.onEvent((type) => {
    lastActivityAt = Date.now()
    pluginHost?.emit(type, {}).catch(() => {})
  })
}

function setupPlugins() {
  pluginHost = new PluginHost({
    log: (...a) => console.log(...a),
    getSettings: () => settings,
    generateIdle: (hint, opts) => {
      if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_AUTONOMY === '1') {
        return Promise.resolve({ plainText:'E2E用の短い独り言です。',
          segments:[{ text:'E2E用の短い独り言です。', emotion:'happy', intensity:0.5, motion:null }] })
      }
      return conversation.generateIdleLine(hint, opts)
    },
    say: (text, segments, opts = {}) => {
      if (opts.signal?.aborted || !settings?.idleTalk?.enabled) return
      if (win && !win.isDestroyed()) win.webContents.send('speech:say', {
        text, segments, generationId:require('node:crypto').randomUUID(), autonomy:true,
      })
    },
    act: action => {
      if (!autonomousActions.includes(action) || settings?.autonomy?.actionsEnabled !== true) return
      if (win && !win.isDestroyed()) win.webContents.send('autonomy:action', { action })
    },
  })
  try {
    const loaded = pluginHost.loadFromDir(path.join(APP_DIR, 'src', 'plugins'))
    console.log('[plugins] loaded:', loaded.join(', ') || '(none)')
  } catch (e) {
    console.error('[plugins] load failed:', e.message)
  }
  // 低頻度の単一タイマーで動作し、独り言のレート制限と集中状態を一元管理する。
  setInterval(() => { checkAutonomy().catch(error => logLaunch('[autonomy]', error.message)) }, 10 * 1000)
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    width: 430,
    height: 680,
    x: workArea.x + workArea.width - 450,
    y: workArea.y + workArea.height - 700,
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: !IS_ELECTRON_E2E,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed() && IS_ELECTRON_E2E) win.hide()
    else if (win && !win.isDestroyed()) win.show()
  })
  const rendererPath = path.join(APP_DIR, 'renderer', 'index.html')
  win.loadFile(rendererPath, IS_ELECTRON_E2E ? { query: { 'deepseek-e2e': '1' } } : undefined)
  if (IS_ELECTRON_E2E) {
    win.webContents.once('did-finish-load', () => {
      win.hide()
      require('./tests/electron-live2d-harness')(win, app)
        .catch(error => {
          logLaunch('[electron-e2e] failed:', error?.stack || error)
          app.exit(1)
        })
    })
  }
  if (process.env.DEEPSEEK_FAST_QA === '1') {
    win.webContents.once('did-finish-load', () => {
      require('./fast-qa')(win, app).catch(e => { logLaunch('[fast-qa]', e.message); app.quit() })
    })
  }
  if (process.env.DEEPSEEK_MOTION_QA === '1') {
    win.webContents.once('did-finish-load', () => {
      require('./motion-qa')(win).catch(e => logLaunch('[motion-qa]', e.message))
    })
  }
win.webContents.on('did-fail-load', (_e, code, desc) => { console.error('[renderer] load failed:', code, desc); logLaunch('[did-fail-load]', code, desc) })
if (process.env.DEEPSEEK_CHAN_SMOKE === '1') {
win.webContents.on('console-message', (_e, level, message) => console.log('[renderer console]', message))
win.webContents.once('did-finish-load', () => {
console.log('[smoke] renderer loaded OK')
if (process.env.DEEPSEEK_CHAN_SMOKE_VOICE === '1') {
require('./voice-smoke-qa')(win, app).catch(error => {
logLaunch('[voice-smoke]', error?.stack || error)
app.exit(1)
})
return
}
if (process.env.DEEPSEEK_CHAN_SMOKE_SHOT) {
setTimeout(async () => {
try {
const img = await win.webContents.capturePage()
require('fs').writeFileSync(process.env.DEEPSEEK_CHAN_SMOKE_SHOT, img.toPNG())
console.log('[smoke] screenshot saved')
} catch (e) {
console.error('[smoke] screenshot failed:', e.message)
}
}, 20000)
}
setTimeout(() => app.quit(), 35000)
})
}
  if (IS_DEV && process.env.DEEPSEEK_CHAN_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  win.webContents.on('render-process-gone', (_e, details) => {
    logLaunch('[render-process-gone]', JSON.stringify(details))
    if (!recreateTried) {
      recreateTried = true
      setTimeout(() => { try { createWindow(); logLaunch('[window] recreated after renderer crash') } catch (e) { logLaunch('[window] recreate failed:', e) } }, 1000)
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logLaunch('[renderer console]', message)
  })
  win.webContents.once('did-finish-load', () => logLaunch('[window] did-finish-load'))
  win.on('closed', () => {
    win = null
  })
}

function setWindowMode(mode) {
  if (!win) return
  windowMode = mode
  const { workArea } = screen.getPrimaryDisplay()
  if (mode === 'full') {
    win.setBounds({
      x: workArea.x + Math.floor(workArea.width * 0.15),
      y: workArea.y + Math.floor(workArea.height * 0.08),
      width: Math.floor(workArea.width * 0.7),
      height: Math.floor(workArea.height * 0.84),
    })
  } else {
    win.setBounds({
      x: workArea.x + workArea.width - 450,
      y: workArea.y + workArea.height - 700,
      width: 430,
      height: 680,
    })
  }
}

function createTray() {
  // トレイアイコンはアバター画像を流用（無い環境では空アイコンで続行）
  const { nativeImage } = require('electron')
  let img = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'avatar', 'deepseek-chan_fullbody.jpg'))
  if (!img.isEmpty()) img = img.resize({ width: 32, height: 32 })
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('DeepSeekちゃん')
  const menu = Menu.buildFromTemplate([
    { label: '表示 / 非表示', click: () => (win?.isVisible() ? win.hide() : win?.show()) },
    { label: 'ペットモード', click: () => setWindowMode('pet') },
    { label: '大きいウィンドウ', click: () => setWindowMode('full') },
    { type: 'separator' },
    { label: 'Qwen3-TTS 公式サイト', click: () => shell.openExternal('https://github.com/QwenLM/Qwen3-TTS') },
    { label: '終了', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()))
}

/* ---------------- IPC ---------------- */

function setupIpc() {
  ipcMain.handle('performance:record', (event, payload) => {
    if (event.sender !== win?.webContents || !payload || typeof payload !== 'object') return false
    return recordPerformanceMetric(payload.event, { turnId: payload.turnId, ...(payload.fields || {}) })
  })
  ipcMain.handle('config:get', () => ({
    settings,
    hasApiKey: Boolean(resolveApiKey()),
    hasDashscopeKey: Boolean(resolveDashscopeKey()),
    plugins: pluginHost ? pluginHost.list() : [],
    windowMode,
  }))

  ipcMain.handle('config:save', (_e, next) => {
    if (settings?.desktopContext?.enabled !== (next?.desktopContext?.enabled === true)) {
      desktopContextPermissionGeneration++
      if (next?.desktopContext?.enabled !== true) desktopContextAbortController?.abort()
      desktopContextCache = unknownDesktopContext()
      desktopContextSampledAt = 0
      previousDesktopIdleMs = null
    }
    settings = config.saveSettings(userFile('settings.json'), next)
    reloadRuntime()
    if (settings.autonomy?.focusMode) {
      autonomyRunController?.abort()
      if (win && !win.isDestroyed()) win.webContents.send('autonomy:interrupt')
    }
    ensureLocalQwen().catch(e => logLaunch("[qwen]", e.message))
    return { settings, hasApiKey: Boolean(resolveApiKey()) }
  })

  ipcMain.on('user:activity', event => {
    if (event.sender !== win?.webContents) return
    noteUserActivity()
  })
  ipcMain.on('presence:update', (event, state) => {
    if (event.sender !== win?.webContents || !state || typeof state !== 'object') return
    setRendererPresence(state)
  })
  if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_AUTONOMY === '1') {
    ipcMain.handle('autonomy:e2e-tick', async (event, options = {}) => {
      if (event.sender !== win?.webContents) return 'blocked'
      const original = {
        actionsEnabled:settings.autonomy?.actionsEnabled,
        focusMode:settings.autonomy?.focusMode,
        speechEnabled:settings.idleTalk?.enabled,
        presence:{...rendererPresence},
      }
      const now = Date.now()
      const idleMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(options.idleMs) || 0))
      settings.autonomy.actionsEnabled = options.actionsEnabled === true
      settings.autonomy.focusMode = options.focusMode === true
      settings.idleTalk.enabled = options.speechEnabled === true
      setRendererPresence({ chatting:options.busy === true, speaking:false, listening:false })
      lastActivityAt = now - idleMs
      const actionIntervalMs = Math.max(1, Math.min(60, Number(settings.autonomy.actionIntervalMinutes) || 5)) * 60 * 1000
      lastAutonomousActionAt = options.allowAction === true ? now - actionIntervalMs : now
      try { return await checkAutonomy(now) } finally {
        settings.autonomy.actionsEnabled = original.actionsEnabled
        settings.autonomy.focusMode = original.focusMode
        settings.idleTalk.enabled = original.speechEnabled
        setRendererPresence(original.presence)
        lastActivityAt = Date.now()
        lastAutonomousActionAt = Date.now()
      }
    })
  }
  if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_DESKTOP === '1') {
    ipcMain.handle('desktop-context:e2e-check', async (event, sample = {}) => {
      if (event.sender !== win?.webContents) return { result:'blocked' }
      const original = { enabled:settings.desktopContext?.enabled, actionsEnabled:settings.autonomy?.actionsEnabled,
        focusMode:settings.autonomy?.focusMode, speechEnabled:settings.idleTalk?.enabled,
        lastSpeechAt:autonomyGuard.lastSpeechAt, speechStarts:[...autonomyGuard.speechStarts],
        inFlight:autonomyGuard.speechInFlight, presence:{...rendererPresence} }
      settings.desktopContext = { enabled:sample.enabled !== false }
      settings.autonomy.actionsEnabled = sample.actionsEnabled === true
      settings.autonomy.focusMode = sample.focusMode === true
      settings.idleTalk.enabled = sample.speechEnabled === true
      setRendererPresence({ chatting:false, speaking:false, listening:false })
      e2eDesktopSample = { idleMs:sample.idleMs, processName:sample.processName, fullscreen:sample.fullscreen }
      desktopContextCache = unknownDesktopContext()
      desktopContextSampledAt = 0
      previousDesktopIdleMs = Number.isFinite(sample.previousIdleMs) ? sample.previousIdleMs : null
      lastActivityAt = Date.now() - Math.max(15 * 60 * 1000, Number(sample.appIdleMs) || 0)
      lastAutonomousActionAt = sample.allowAction === true ? Date.now() - 600_000 : Date.now()
      try {
        const result = await checkAutonomy(Date.now())
        return { result, context:await getDesktopContext(Date.now()), policy:deriveDesktopPolicy(desktopContextCache) }
      } finally {
        settings.desktopContext.enabled = original.enabled
        settings.autonomy.actionsEnabled = original.actionsEnabled
        settings.autonomy.focusMode = original.focusMode
        settings.idleTalk.enabled = original.speechEnabled
        autonomyGuard.lastSpeechAt = original.lastSpeechAt
        autonomyGuard.speechStarts = original.speechStarts
        autonomyGuard.speechInFlight = original.inFlight
        setRendererPresence(original.presence)
        e2eDesktopSample = null
        desktopContextCache = unknownDesktopContext()
        desktopContextSampledAt = 0
        previousDesktopIdleMs = null
        lastActivityAt = Date.now()
        lastAutonomousActionAt = Date.now()
      }
    })
  }

  ipcMain.handle('desktop-context:silent-allowed', async (event) => {
    if (event.sender !== win?.webContents || settings?.features?.silentReactions !== true || settings?.autonomy?.focusMode === true) return false
    if (settings?.desktopContext?.enabled !== true) return true
    const context = await getDesktopContext(Date.now())
    if (settings?.features?.silentReactions !== true || settings?.desktopContext?.enabled !== true || settings?.autonomy?.focusMode === true) return false
    return allowsSilentReaction({ enabled:settings.features.silentReactions,
      focusMode:settings.autonomy?.focusMode, desktopEnabled:settings.desktopContext?.enabled }, context)
  })

  ipcMain.handle('config:setApiKey', (_e, key) => {
    writeUserEnvKey(String(key || '').trim())
    reloadRuntime()
    return { hasApiKey: Boolean(resolveApiKey()) }
  })

  ipcMain.handle('config:setDashscopeKey', (_e, key) => {
    writeUserEnvVar('DASHSCOPE_API_KEY', String(key || '').trim())
    reloadRuntime()
    return { hasDashscopeKey: Boolean(resolveDashscopeKey()) }
  })

  ipcMain.handle('history:list', () => history.list())
  ipcMain.handle('history:search', (_e, q) => history.search(q))
  ipcMain.handle('history:clear', () => {
    history.clear()
    return true
  })

  const isMemoryWindow = event => event.sender === win?.webContents && Boolean(longTermMemory)
  ipcMain.handle('memory:list', event => {
    if (!isMemoryWindow(event)) return { items:[], status:{ writable:false, loadError:'アクセスが拒否されました' } }
    return { items:longTermMemory.list(), status:longTermMemory.status() }
  })
  ipcMain.handle('memory:scan-history', event => {
    if (!isMemoryWindow(event)) return { candidates:[], error:'アクセスが拒否されました' }
    const candidates = []
    for (const message of history.list().filter(item => item.role === 'user').slice(-1000)) {
      const found = extractCandidates(message.content, Date.parse(message.ts) || Date.now())
      found.forEach((candidate, candidateIndex) => {
        if (longTermMemory.hasCandidateSource(message.id, candidate)) return
        candidates.push({ sourceMessageId:String(message.id).slice(0, 120), sourceDate:message.ts || null,
          candidateIndex, candidate:{ type:candidate.type, content:candidate.content, status:candidate.status,
            expiresAt:candidate.expiresAt, confidence:candidate.confidence } })
      })
      if (candidates.length >= 100) break
    }
    return { candidates:candidates.slice(0, 100) }
  })
  ipcMain.handle('memory:import-history-candidate', (event, sourceMessageId, candidateIndex) => {
    if (!isMemoryWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    const message = history.list().find(item => item.role === 'user' && item.id === String(sourceMessageId || ''))
    const index = Number(candidateIndex)
    if (!message || !Number.isInteger(index) || index < 0) return { ok:false, error:'履歴の候補が見つかりません' }
    const candidate = extractCandidates(message.content, Date.parse(message.ts) || Date.now())[index]
    if (!candidate) return { ok:false, error:'記憶候補が見つかりません' }
    try { return { ok:true, item:longTermMemory.addCandidate(candidate, { messageId:message.id }) } }
    catch (error) { return { ok:false, error:String(error?.message || '記憶候補を保存できません').slice(0, 180) } }
  })
  ipcMain.handle('memory:add', (event, input) => {
    if (!isMemoryWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { return { ok:true, item:longTermMemory.addManual(input) } }
    catch (error) { return { ok:false, error:String(error?.message || '記憶を追加できません').slice(0, 180) } }
  })
  ipcMain.handle('memory:update', (event, id, patch) => {
    if (!isMemoryWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try {
      const item = longTermMemory.update(String(id || ''), patch)
      return item ? { ok:true, item } : { ok:false, error:'記憶が見つかりません' }
    } catch (error) { return { ok:false, error:String(error?.message || '記憶を更新できません').slice(0, 180) } }
  })
  ipcMain.handle('memory:delete', (event, id) => {
    if (!isMemoryWindow(event)) return false
    try { return longTermMemory.delete(String(id || '')) } catch { return false }
  })
  ipcMain.handle('memory:clear', event => {
    if (!isMemoryWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { longTermMemory.clear(); followUpScheduler?.clear(); return { ok:true } }
    catch (error) { return { ok:false, error:String(error?.message || '記憶を削除できません').slice(0, 180) } }
  })

  const isProactiveWindow = event => event.sender === win?.webContents && Boolean(followUpScheduler && longTermMemory)
  ipcMain.handle('proactive:state', event => {
    if (!isProactiveWindow(event)) return { writable:false, loadError:'アクセスが拒否されました', mutedMemoryIds:[] }
    return followUpScheduler.status(longTermMemory.list({ skipExpiry:true }))
  })
  ipcMain.handle('proactive:set-muted', (event, memoryId, muted) => {
    if (!isProactiveWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    const item = longTermMemory.list({ skipExpiry:true }).find(row => row.id === String(memoryId || ''))
    if (!item || !['open_loop','commitment'].includes(item.type)) return { ok:false, error:'通知対象の記憶が見つかりません' }
    try { return { ok:true, muted:followUpScheduler.setMuted(item, muted === true) } }
    catch (error) { return { ok:false, error:String(error?.message || '通知設定を保存できません').slice(0, 160) } }
  })
  ipcMain.handle('proactive:respond', (event, memoryId, action, nextAt) => {
    if (!isProactiveWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    if (!['completed','later','working','mute','dismiss'].includes(action)) return { ok:false, error:'操作が無効です' }
    const item = longTermMemory.list({ skipExpiry:true }).find(row => row.id === String(memoryId || ''))
    if (!item || !['open_loop','commitment'].includes(item.type) || !followUpScheduler.hasPending(item)) return { ok:false, error:'通知中の話題が見つかりません' }
    try {
      const now = Date.now()
      const requestedNextAt = Number(nextAt)
      const safeNextAt = Number.isFinite(requestedNextAt) && requestedNextAt > now
        ? Math.min(requestedNextAt, now + 365 * 24 * 60 * 60 * 1000) : now + 7 * 24 * 60 * 60 * 1000
      if (action === 'completed') longTermMemory.update(item.id, { status:'completed', followUpAt:null })
      if (action === 'later') longTermMemory.update(item.id, { status:'postponed', followUpAt:new Date(safeNextAt).toISOString() })
      if (action === 'working') longTermMemory.update(item.id, { status:'active', followUpAt:new Date(safeNextAt).toISOString() })
      const saved = followUpScheduler.respond(item, action, { now, nextAt:safeNextAt })
      return saved ? { ok:true } : { ok:false, error:'フォローアップ状態を更新できませんでした' }
    } catch (error) { return { ok:false, error:String(error?.message || '状態を更新できません').slice(0, 160) } }
  })
  ipcMain.handle('proactive:speech-finished', (event, generationId) => {
    if (event.sender !== win?.webContents || !proactiveSpeechGenerationId
        || String(generationId || '') !== proactiveSpeechGenerationId) return false
    proactiveSpeechGenerationId = null
    autonomyGuard.finishSpeech()
    autonomyRunInFlight = false
    persistAutonomyBudget()
    return true
  })

  const isCalendarWindow = event => event.sender === win?.webContents && Boolean(calendarStore)
  ipcMain.handle('calendar:status', event => isCalendarWindow(event)
    ? calendarStore.status() : { writable:false, loadError:'アクセスが拒否されました', count:0 })
  ipcMain.handle('calendar:month', (event, year, month) => {
    if (!isCalendarWindow(event)) return { items:[], error:'アクセスが拒否されました' }
    try { return { items:calendarStore.month(Number(year), Number(month)) } }
    catch (error) { return { items:[], error:String(error?.message || '月間予定を取得できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:date', (event, date) => {
    if (!isCalendarWindow(event)) return { items:[], error:'アクセスが拒否されました' }
    try { return { items:calendarStore.occurrencesForDate(String(date || '')) } }
    catch (error) { return { items:[], error:String(error?.message || '日付の予定を取得できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:summary', event => {
    if (!isCalendarWindow(event)) return { today:[], tomorrow:[], week:[], error:'アクセスが拒否されました' }
    try { return calendarStore.summary() }
    catch (error) { return { today:[], tomorrow:[], week:[], error:String(error?.message || '予定の要約を取得できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar-presence:briefing', event => {
    if (!isCalendarWindow(event)) return { lines:[], spoken:'', error:'アクセスが拒否されました' }
    try { return buildBriefing(calendarStore.summary(),Date.now()) }
    catch(error) { return { lines:[],spoken:'',error:String(error?.message||'今日の予定を取得できません').slice(0,160) } }
  })
  ipcMain.handle('calendar-presence:history', event => isCalendarWindow(event) && calendarPresence
    ? calendarPresence.history() : { writable:false,entries:[],countToday:0 })
  ipcMain.handle('calendar-presence:pause', event => {
    if (!isCalendarWindow(event) || !calendarPresence) return {ok:false,error:'アクセスが拒否されました'}
    try { return {ok:true,pausedUntil:calendarPresence.pause(Date.now()+PRESENCE_DAY_MS)} }
    catch(error) { return {ok:false,error:String(error?.message||'一時停止を保存できません').slice(0,160)} }
  })
  ipcMain.handle('calendar-presence:resume', event => {
    if (!isCalendarWindow(event) || !calendarPresence) return {ok:false,error:'アクセスが拒否されました'}
    try { calendarPresence.resume(); return {ok:true} }
    catch(error) { return {ok:false,error:String(error?.message||'再開できません').slice(0,160)} }
  })
  ipcMain.handle('calendar-presence:respond', async (event,payload) => event.sender===win?.webContents
    ? respondToCalendarPresence(payload) : {ok:false,error:'アクセスが拒否されました'})
  ipcMain.handle('calendar:resolve-local-time', (event, date, time, timeZone) => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { return { ok:true, iso:zonedDateTimeToIso(String(date || ''), String(time || ''), String(timeZone || '')) } }
    catch (error) { return { ok:false, error:String(error?.message || '日時が無効です').slice(0, 150) } }
  })
  ipcMain.handle('calendar:get', (event, id) => isCalendarWindow(event) ? calendarStore.get(String(id || '')) : null)
  ipcMain.handle('calendar:search', (event, query, category = '') => {
    if (!isCalendarWindow(event)) return { items:[], error:'アクセスが拒否されました' }
    try { return { items:calendarStore.search(String(query || ''), String(category || '')) } }
    catch (error) { return { items:[], error:String(error?.message || '予定を検索できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:add', (event, input) => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { return { ok:true, ...calendarStore.add(input) } }
    catch (error) { return { ok:false, error:String(error?.message || '予定を保存できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:update', (event, id, patch) => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { const item = calendarStore.update(id, patch); if (item) clearCalendarNoticeForEvent(id); return item ? { ok:true, item } : { ok:false, error:'予定が見つかりません' } }
    catch (error) { return { ok:false, error:String(error?.message || '予定を更新できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:update-occurrence', (event, occurrenceId, patch) => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { const item = calendarStore.updateOccurrence(occurrenceId, patch); if (item) clearCalendarNoticeForEvent(occurrenceId,true); return item ? { ok:true, item } : { ok:false, error:'繰り返し予定が見つかりません' } }
    catch (error) { return { ok:false, error:String(error?.message || '予定を更新できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:delete', (event, id) => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { const deleted = calendarStore.delete(id); if (deleted) clearCalendarNoticeForEvent(id); return deleted ? { ok:true } : { ok:false, error:'予定が見つかりません' } }
    catch (error) { return { ok:false, error:String(error?.message || '予定を削除できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:delete-occurrence', (event, occurrenceId) => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { const deleted = calendarStore.deleteOccurrence(occurrenceId); if (deleted) clearCalendarNoticeForEvent(occurrenceId,true); return deleted ? { ok:true } : { ok:false, error:'繰り返し予定が見つかりません' } }
    catch (error) { return { ok:false, error:String(error?.message || '予定を削除できません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:export', async event => {
    if (!isCalendarWindow(event) || !win || win.isDestroyed()) return { ok:false, error:'アクセスが拒否されました' }
    const choice = await dialog.showSaveDialog(win, { title:'カレンダーをバックアップ', defaultPath:'deepseek-chan-calendar.json',
      filters:[{ name:'DeepSeekちゃんカレンダー', extensions:['json'] }], properties:['showOverwriteConfirmation'] })
    if (choice.canceled || !choice.filePath) return { ok:false, canceled:true }
    try { calendarStore.exportFile(choice.filePath); return { ok:true } }
    catch (error) { return { ok:false, error:String(error?.message || 'バックアップを書き出せません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:import', async event => {
    if (!isCalendarWindow(event) || !win || win.isDestroyed()) return { ok:false, error:'アクセスが拒否されました' }
    const choice = await dialog.showOpenDialog(win, { title:'カレンダーバックアップを読み込む', properties:['openFile'],
      filters:[{ name:'DeepSeekちゃんカレンダー', extensions:['json'] }] })
    if (choice.canceled || !choice.filePaths?.[0]) return { ok:false, canceled:true }
    try { return { ok:true, ...calendarStore.importFile(choice.filePaths[0]) } }
    catch (error) { return { ok:false, error:String(error?.message || 'バックアップを読み込めません').slice(0, 180) } }
  })
  ipcMain.handle('calendar:restore-backup', event => {
    if (!isCalendarWindow(event)) return { ok:false, error:'アクセスが拒否されました' }
    try { return { ok:true, ...calendarStore.restoreBackup() } }
    catch (error) { return { ok:false, error:String(error?.message || 'バックアップを復元できません').slice(0, 180) } }
  })
  if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_CALENDAR === '1') {
    ipcMain.handle('calendar:e2e-state', event => {
      if (!isCalendarWindow(event)) return null
      return { status:calendarStore.status(), events:calendarStore.list(), settings:settings.calendar }
    })
    ipcMain.handle('calendar-presence:e2e-scenario', async event => {
      if (!isCalendarWindow(event) || !calendarStore || !calendarPresence || calendarPresenceE2EState) return { result:'blocked' }
      const original={ calendarPresence:{...settings.calendarPresence,quietHours:{...settings.calendarPresence?.quietHours}},
        focusMode:settings.autonomy?.focusMode, desktopEnabled:settings.desktopContext?.enabled,
        calendarPresenceStartedAt,lastActivityAt,lastAutonomousActionAt,desktopContextCache,desktopContextSampledAt,
        speechLastAt:autonomyGuard.lastSpeechAt,speechStarts:[...autonomyGuard.speechStarts],speechInFlight:autonomyGuard.speechInFlight,
        visible:win?.isVisible(),presence:{...rendererPresence} }
      const now=Date.now()
      const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'
      try {
        calendarPresenceE2EState={original,added:[],now}
        settings.calendarPresence={...DEFAULT_CALENDAR_PRESENCE,classQuietEnabled:true,classQuietLeadMinutes:0,
          quietHours:{enabled:false,start:'22:00',end:'08:00'}}
        settings.autonomy.focusMode=false; settings.desktopContext.enabled=false
        if (!win.isVisible()) win.show()
        calendarPresenceStartedAt=now-5*60_000; lastActivityAt=now-10*60_000; lastAutonomousActionAt=now
        autonomyGuard.restoreState([]); autonomyGuard.finishSpeech(); setRendererPresence({chatting:false,speaking:false,listening:false})
        const lesson=calendarStore.add({title:'E2E lesson',category:'lesson',timeZone:zone,
          startAt:new Date(now-60_000).toISOString(),endAt:new Date(now+60*60_000).toISOString(),notify:false})
        calendarPresenceE2EState.added.push(lesson.item.id)
        const classQuietResult=await checkAutonomy(now)
        calendarStore.delete(lesson.item.id); calendarPresenceE2EState.added.pop()

        settings.calendarPresence={...settings.calendarPresence,classQuietEnabled:false,deadlineRemindersEnabled:true,reminderLeadMinutes:120}
        const due=new Date(now+120*60_000).toISOString()
        const assignment=calendarStore.add({title:'E2E assignment',category:'assignment',timeZone:zone,deadlineAt:due,notify:true})
        calendarPresenceE2EState.added.push(assignment.item.id)
        const second=calendarStore.add({title:'E2E second assignment',category:'assignment',timeZone:zone,deadlineAt:due,notify:true})
        calendarPresenceE2EState.added.push(second.item.id)
        const result=await checkAutonomy(now)
        return {classQuietResult,result,noticeEmitted:result==='calendar-deadline'&&Boolean(activeCalendarNotice?.key),
          externalApiCalled:false,realQwenAudioPlayed:false}
      } catch (error) {
        finishCalendarPresenceE2EState()
        throw error
      }
    })
    ipcMain.handle('calendar-presence:e2e-budget-check', async event => {
      if (!isCalendarWindow(event) || !calendarPresenceE2EState) return { result:'blocked' }
      const state=calendarPresenceE2EState, now=state.now+1
      try {
        const budgetBlockedBySharedGuard=!autonomyGuard.canSpeak({enabled:true,voiceEnabled:true,focusMode:false,busy:false,
          idleForMs:now-lastActivityAt,idleThresholdMs:MIN_IDLE_MS,now})
        const result=await checkAutonomy(now)
        return {budgetBlockedBySharedGuard,result,externalApiCalled:false,realQwenAudioPlayed:false}
      } finally { finishCalendarPresenceE2EState() }
    })
  }
  if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_FOLLOWUPS === '1') {
    ipcMain.handle('proactive:e2e-tick', async (event, options = {}) => {
      if (event.sender !== win?.webContents) return 'blocked'
      const original = { proactive:{...settings.proactive, quietHours:{...settings.proactive?.quietHours}},
        memoryLongTermEnabled:settings.memory?.longTermEnabled, lastActivityAt,
        focusMode:settings.autonomy?.focusMode, desktopEnabled:settings.desktopContext?.enabled,
        desktopContextCache, startedAt:followUpScheduler.startedAt,
        speechLastAt:autonomyGuard.lastSpeechAt, speechStarts:[...autonomyGuard.speechStarts],
        speechInFlight:autonomyGuard.speechInFlight }
      settings.proactive = { ...settings.proactive, followUpsEnabled:options.enabled === true,
        delivery:options.delivery === 'voice' ? 'voice' : 'bubble', dailyMax:options.dailyMax || 2,
        quietHours:{ enabled:false, start:'22:00', end:'08:00' } }
      settings.memory.longTermEnabled = options.memoryEnabled === true
      settings.autonomy.focusMode = options.focusMode === true
      settings.desktopContext.enabled = options.desktopEnabled === true
      desktopContextCache = options.desktopContext || unknownDesktopContext()
      followUpScheduler.startedAt = Date.now() - START_DELAY_MS - 1000
      lastActivityAt = Date.now() - Math.max(MIN_IDLE_MS, Number(options.idleMs) || MIN_IDLE_MS)
      // The E2E scenario verifies follow-up delivery in isolation. Earlier E2E stages
      // may have exercised the shared production speech budget in this same app process.
      autonomyGuard.lastSpeechAt = -Infinity
      autonomyGuard.speechStarts = []
      autonomyGuard.speechInFlight = false
      setRendererPresence({ chatting:options.busy === true, speaking:false, listening:false })
      try {
        return await checkProactiveFollowUp({ now:Date.now(), idleForMs:Date.now() - lastActivityAt,
          busy:options.busy === true, focusMode:settings.autonomy.focusMode,
          desktopContext:desktopContextCache, desktopPolicy:deriveDesktopPolicy(desktopContextCache), testMode:true })
      } finally {
        settings.proactive = original.proactive
        settings.memory.longTermEnabled = original.memoryLongTermEnabled
        settings.autonomy.focusMode = original.focusMode
        settings.desktopContext.enabled = original.desktopEnabled
        desktopContextCache = original.desktopContextCache
        followUpScheduler.startedAt = original.startedAt
        lastActivityAt = original.lastActivityAt
        autonomyGuard.lastSpeechAt = original.speechLastAt
        autonomyGuard.speechStarts = original.speechStarts
        autonomyGuard.speechInFlight = original.speechInFlight
        setRendererPresence({ chatting:false, speaking:false, listening:false })
      }
    })
  }

  ipcMain.handle('chat:send', async (e, text, generationId) => {
    if (process.env.DEEPSEEK_FAST_QA === '1' && !IS_ELECTRON_E2E) {
      const raw = 'こんにちは、きみ。DeepSeekちゃんだよ。'
      const id = String(generationId || '')
      e.sender.send('chat:token', {generationId:id, delta:raw})
      return {plainText:raw, segments:[{emotion:'happy',motion:'wave',text:raw}], raw, generationId:id}
    }
    const senderId = e.sender.id
    noteUserActivity()
    setRendererPresence({ chatting:true })
    const previous = chatRequests.get(senderId)
    previous?.controller.abort()
    const request = { generationId: String(generationId || ''), controller: new AbortController() }
    chatRequests.set(senderId, request)
    lastActivityAt = Date.now()
    try {
      let result
      if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_CHAT === '1') {
        const fixtures = [
          { token:'[neutral]一文目のテストです。', text:'一文目のテストです。', emotion:'neutral', intensity:null },
          { token:'[excited:0.7]二文目も続きます。', text:'二文目も続きます。', emotion:'excited', intensity:0.7 },
          { token:'[neutral]最後のテスト文です。', text:'最後のテスト文です。', emotion:'neutral', intensity:null },
        ]
        let raw = ''
        for (const fixture of fixtures) {
          if (request.controller.signal.aborted) return { interrupted:true, generationId:request.generationId }
          raw += fixture.token
          if (!e.sender.isDestroyed() && chatRequests.get(senderId) === request) {
            e.sender.send('chat:token', { generationId:request.generationId, delta:fixture.token })
          }
          await new Promise(resolve => setTimeout(resolve, 700))
        }
        result = { raw, plainText:fixtures.map(row => row.text).join(''),
          segments:fixtures.map(({text,emotion,intensity}) => ({text,emotion,intensity})) }
      } else {
        result = await conversation.send(text, {
          signal: request.controller.signal,
          onToken: (delta) => {
          if (!e.sender.isDestroyed() && chatRequests.get(senderId) === request) {
            e.sender.send('chat:token', {generationId:request.generationId, delta})
          }
          },
        })
      }
      lastActivityAt = Date.now()
      if (request.controller.signal.aborted || chatRequests.get(senderId) !== request) {
        return { interrupted:true, generationId:request.generationId }
      }
      return { ...result, generationId:request.generationId }
    } catch (error) {
      if (request.controller.signal.aborted || error?.name === 'AbortError') {
        return { interrupted:true, generationId:request.generationId }
      }
      throw error
    } finally {
      if (chatRequests.get(senderId) === request) {
        chatRequests.delete(senderId)
        setRendererPresence({ chatting:false })
      }
    }
  })
  ipcMain.on('chat:cancel', (e, generationId) => {
    const request = chatRequests.get(e.sender.id)
    if (request && request.generationId === generationId) request.controller.abort()
  })

  ipcMain.handle('voice:status', async () => {
    return {engine:'voice-a-fast', ...(await fastStatus())}
  })

  ipcMain.handle('legacy:voice:status', async () => {
    if (settings.voice.engine === 'qwen3') {
      return { engine: 'qwen3', ...(await qwenTts.status()), mode: settings.qwen.mode }
    }
    return { engine: 'voicevox', available: await voicevox.isAvailable(), baseUrl: settings.voice.serverUrl }
  })
  ipcMain.handle('voice:speakers', async () => [{id:'voice-a', label:'お気に入りの声'}])

  ipcMain.handle('legacy:voice:speakers', async () => {
    if (settings.voice.engine === 'qwen3') return qwenTts.speakers()
    return voicevox.speakers()
  })
  ipcMain.handle('legacy:voice:synthesize', async (_e, text, opts = {}) => {
    if (settings.voice.engine === 'qwen3') {
      const buf = await qwenTts.synthesize(text, {
        speaker: opts.speaker ?? settings.qwen.speaker,
        language: opts.language ?? settings.qwen.language,
        instruct: opts.instruct ?? settings.qwen.instruct,
        speed: opts.speed ?? settings.qwen.speed ?? 1,
        pitch: opts.pitch ?? settings.qwen.pitch ?? 0,
      })
      return new Uint8Array(buf)
    }
    const buf = await voicevox.synthesize(text, {
      speaker: opts.speaker ?? settings.voice.speaker,
      speedScale: opts.speedScale ?? settings.voice.speedScale,
      pitchScale: opts.pitchScale ?? settings.voice.pitchScale,
      intonationScale: opts.intonationScale ?? settings.voice.intonationScale,
    })
    return new Uint8Array(buf)
  })

  const voiceStreams = new Map()
  ipcMain.on('fast-voice:start', async (event, data) => {
    const id = data?.id
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id) ||
        typeof data.text !== 'string' || !data.text.trim() || data.text.length > 300 || voiceStreams.has(id)) return
    const controller = new AbortController()
    const generationId = typeof data.generationId === 'string' ? data.generationId : ''
    const purpose = data.purpose === 'filler' ? 'filler' : 'speech'
    voiceStreams.set(id, {controller, senderId:event.sender.id, generationId})
    const send = (type, value) => {
      if (!event.sender.isDestroyed()) event.sender.send('fast-voice:event', {id, generationId, type, ...value})
    }
    try {
      if (IS_ELECTRON_E2E && process.env.DEEPSEEK_E2E_PCM === '1') {
        const silence = new Uint8Array(9600)
        const chunkDelayMs = Math.max(10, Math.min(500, Number(process.env.DEEPSEEK_E2E_PCM_DELAY_MS) || 10))
        for (let i = 0; i < 60; i++) {
          // Keep synthetic TTS faster than the deliberately paced fake LLM so
          // E2E can assert that a completed sentence starts before the full reply.
          await new Promise(resolve => setTimeout(resolve, Math.max(20, chunkDelayMs)))
          if (controller.signal.aborted) {
            send('audio', {chunk:silence})
            const error = new Error('aborted')
            error.name = 'AbortError'
            throw error
          }
          send('audio', {chunk:silence})
        }
        send('done', {})
        return
      }
      const res = await fetch(`${FAST_URL}/stream`, {method:'POST', signal:controller.signal,
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:data.text, purpose})})
      if (!res.ok) {
        const info = await res.json().catch(() => ({}))
        throw new Error(info.error || `音声エンジンエラー (${res.status})`)
      }
      const reader = res.body.getReader()
      let count = 0
      for (;;) {
        const {value, done} = await reader.read()
        if (done) break
        if (value?.byteLength) { count += value.byteLength; send('audio', {chunk:value}) }
      }
      if (!count) throw new Error('音声データを受け取れませんでした')
      send('done', {})
    } catch (e) { send('error', {aborted:e.name === 'AbortError', message:e.name === 'AbortError' ? '読み上げを停止しました' : String(e.message || e)}) }
    finally { voiceStreams.delete(id) }
  })
  ipcMain.on('fast-voice:cancel', (event, id) => {
    const task = voiceStreams.get(id)
    if (task && task.senderId === event.sender.id) task.controller.abort()
  })
  ipcMain.on('fast-voice:cancel-generation', (event, generationId) => {
    for (const task of voiceStreams.values()) {
      if (task.senderId === event.sender.id && task.generationId === generationId) task.controller.abort()
    }
  })

  ipcMain.handle('window:setMode', (_e, mode) => {
    setWindowMode(mode)
    return windowMode
  })
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:hide', () => win?.hide())
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\//.test(String(url))) return shell.openExternal(String(url))
    return false
  })
}

/* ---------------- 起動 ---------------- */

app.whenReady().then(() => {
  try {
  logLaunch('[ready] app ready')
  settings = config.loadSettings(userFile('settings.json'))
  history = new HistoryStore(userFile('chat-history.json'))
  history.load()
  longTermMemory = new LongTermMemoryStore(userFile('long-term-memory.json'))
  longTermMemory.load()
  followUpScheduler = new FollowUpScheduler(userFile('proactive-followups.json'))
  calendarStore = new CalendarStore(userFile('calendar.json'))
  calendarStore.load()
  calendarPresence = new CalendarPresenceManager(userFile('calendar-presence.json'))
  calendarPresenceStartedAt = Date.now()
  reloadRuntime()
  ensureLocalQwen().catch(e => logLaunch("[qwen]", e.message))
  setupPlugins()
  setupIpc()
  createWindow()
  sampleProcessPerformance()
  setInterval(sampleProcessPerformance, 15000).unref?.()
  try { createTray() } catch (e) { logLaunch('[tray] create failed (continuing):', e) }
  logLaunch('[ready] window + tray created')
  } catch (e) {
    logLaunch('[ready] startup failed:', e)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', (e) => {
  // トレイ常駐アプリなので、ウィンドウを閉じても終了しない（トレイの「終了」で終了）
  if (process.platform !== 'darwin') {
    // hide 運用のため何もしない
  }
})
