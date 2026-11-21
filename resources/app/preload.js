'use strict'
/**
 * preload.js — レンダラーへ安全に公開するブリッジ（window.deepseekChan）
 * APIキーそのものはレンダラーへ渡さない（hasApiKey の真偽のみ）。
 */
const { contextBridge, ipcRenderer } = require('electron')

const bridge = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  silentReactionAllowed: () => ipcRenderer.invoke('desktop-context:silent-allowed'),
  saveConfig: (settings) => ipcRenderer.invoke('config:save', settings),
  setApiKey: (key) => ipcRenderer.invoke('config:setApiKey', key),
  setDashscopeKey: (key) => ipcRenderer.invoke('config:setDashscopeKey', key),
  listHistory: () => ipcRenderer.invoke('history:list'),
  searchHistory: (q) => ipcRenderer.invoke('history:search', q),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listMemories: () => ipcRenderer.invoke('memory:list'),
  scanMemoryHistory: () => ipcRenderer.invoke('memory:scan-history'),
  importMemoryHistoryCandidate: (messageId, candidateIndex) => ipcRenderer.invoke('memory:import-history-candidate', messageId, candidateIndex),
  addMemory: (input) => ipcRenderer.invoke('memory:add', input),
  updateMemory: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  clearMemories: () => ipcRenderer.invoke('memory:clear'),
  calendarStatus: () => ipcRenderer.invoke('calendar:status'),
  calendarMonth: (year, month) => ipcRenderer.invoke('calendar:month', year, month),
  calendarDate: date => ipcRenderer.invoke('calendar:date', date),
  calendarSummary: () => ipcRenderer.invoke('calendar:summary'),
  calendarPresenceBriefing: () => ipcRenderer.invoke('calendar-presence:briefing'),
  calendarPresenceHistory: () => ipcRenderer.invoke('calendar-presence:history'),
  pauseCalendarPresence: () => ipcRenderer.invoke('calendar-presence:pause'),
  resumeCalendarPresence: () => ipcRenderer.invoke('calendar-presence:resume'),
  respondToCalendarPresence: payload => ipcRenderer.invoke('calendar-presence:respond', payload),
  searchCalendar: (query, category) => ipcRenderer.invoke('calendar:search', query, category),
  resolveCalendarLocalTime: (date, time, timeZone) => ipcRenderer.invoke('calendar:resolve-local-time', date, time, timeZone),
  getCalendarEvent: id => ipcRenderer.invoke('calendar:get', id),
  addCalendarEvent: input => ipcRenderer.invoke('calendar:add', input),
  updateCalendarEvent: (id, patch) => ipcRenderer.invoke('calendar:update', id, patch),
  updateCalendarOccurrence: (occurrenceId, patch) => ipcRenderer.invoke('calendar:update-occurrence', occurrenceId, patch),
  deleteCalendarEvent: id => ipcRenderer.invoke('calendar:delete', id),
  deleteCalendarOccurrence: occurrenceId => ipcRenderer.invoke('calendar:delete-occurrence', occurrenceId),
  exportCalendar: () => ipcRenderer.invoke('calendar:export'),
  importCalendar: () => ipcRenderer.invoke('calendar:import'),
  restoreCalendarBackup: () => ipcRenderer.invoke('calendar:restore-backup'),
  proactiveState: () => ipcRenderer.invoke('proactive:state'),
  setFollowUpMuted: (memoryId, muted) => ipcRenderer.invoke('proactive:set-muted', memoryId, muted),
  respondToFollowUp: (memoryId, action, nextAt) => ipcRenderer.invoke('proactive:respond', memoryId, action, nextAt),
  finishProactiveSpeech: generationId => ipcRenderer.invoke('proactive:speech-finished', generationId),
  sendChat: (text, generationId) => ipcRenderer.invoke('chat:send', text, generationId),
  cancelChat: (generationId) => ipcRenderer.send('chat:cancel', generationId),
  recordPerformanceMetric: (event, turnId, fields = {}) => ipcRenderer.invoke('performance:record', { event, turnId, fields }),
  onChatToken: (fn) => {
    const h = (_e, payload) => fn(payload)
    ipcRenderer.on('chat:token', h)
    return () => ipcRenderer.removeListener('chat:token', h)
  },
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  startVoiceStream: (id, text, generationId, purpose = 'speech') => ipcRenderer.send('fast-voice:start', {id, text, generationId, purpose}),
  cancelVoiceStream: (id) => ipcRenderer.send('fast-voice:cancel', id),
  cancelVoiceGeneration: (generationId) => ipcRenderer.send('fast-voice:cancel-generation', generationId),
  onVoiceStream: (fn) => {
    const h = (_e, event) => fn(event)
    ipcRenderer.on('fast-voice:event', h)
    return () => ipcRenderer.removeListener('fast-voice:event', h)
  },
  voiceSpeakers: () => ipcRenderer.invoke('voice:speakers'),
  synthesize: (text, opts) => ipcRenderer.invoke('voice:synthesize', text, opts),
  onPluginSay: (fn) => {
    const h = (_e, payload) => fn(payload)
    ipcRenderer.on('speech:say', h)
    return () => ipcRenderer.removeListener('speech:say', h)
  },
  onAutonomyAction: (fn) => {
    const h = (_e, payload) => fn(payload)
    ipcRenderer.on('autonomy:action', h)
    return () => ipcRenderer.removeListener('autonomy:action', h)
  },
  onAutonomyInterrupt: (fn) => {
    const h = () => fn()
    ipcRenderer.on('autonomy:interrupt', h)
    return () => ipcRenderer.removeListener('autonomy:interrupt', h)
  },
  onFollowUp: (fn) => {
    const h = (_e, payload) => fn(payload)
    ipcRenderer.on('proactive:follow-up', h)
    return () => ipcRenderer.removeListener('proactive:follow-up', h)
  },
  onCalendarPresenceNotice: fn => {
    const h=(_e,payload)=>fn(payload)
    ipcRenderer.on('calendar-presence:notice',h)
    return ()=>ipcRenderer.removeListener('calendar-presence:notice',h)
  },
  onCalendarPresenceClear: fn => {
    const h=(_e,payload)=>fn(payload)
    ipcRenderer.on('calendar-presence:clear',h)
    return ()=>ipcRenderer.removeListener('calendar-presence:clear',h)
  },
  onProactiveCancel: (fn) => {
    const h = (_e, generationId) => fn(generationId)
    ipcRenderer.on('proactive:cancel', h)
    return () => ipcRenderer.removeListener('proactive:cancel', h)
  },
  notifyActivity: () => ipcRenderer.send('user:activity'),
  reportPresence: (presence) => ipcRenderer.send('presence:update', presence),
  setWindowMode: (mode) => ipcRenderer.invoke('window:setMode', mode),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
}
if (process.env.DEEPSEEK_E2E === '1' && process.env.DEEPSEEK_E2E_AUTONOMY === '1') {
  bridge.triggerAutonomyTestTick = options => ipcRenderer.invoke('autonomy:e2e-tick', options)
}
if (process.env.DEEPSEEK_E2E === '1' && process.env.DEEPSEEK_E2E_DESKTOP === '1') {
  bridge.checkDesktopContextTestSample = sample => ipcRenderer.invoke('desktop-context:e2e-check', sample)
}
if (process.env.DEEPSEEK_E2E === '1' && process.env.DEEPSEEK_E2E_FOLLOWUPS === '1') {
  bridge.triggerFollowUpTestTick = options => ipcRenderer.invoke('proactive:e2e-tick', options)
}
if (process.env.DEEPSEEK_E2E === '1' && process.env.DEEPSEEK_E2E_CALENDAR === '1') {
  bridge.calendarE2EState = () => ipcRenderer.invoke('calendar:e2e-state')
  bridge.calendarPresenceE2EScenario = () => ipcRenderer.invoke('calendar-presence:e2e-scenario')
  bridge.calendarPresenceE2EBudgetCheck = () => ipcRenderer.invoke('calendar-presence:e2e-budget-check')
}
contextBridge.exposeInMainWorld('deepseekChan', bridge)
