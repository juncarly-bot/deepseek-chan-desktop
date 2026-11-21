'use strict'
/**
 * renderer.js — 画面側オーケストレーション
 *
 * - チャット送受信（メイン経由で DeepSeek、トークンはストリーミング表示）
 * - 読み上げキュー: 文ごとに VOICEVOX 合成 → 再生しながら AnalyserNode で
 *   音量を取り、アバターの口パクを駆動する。VOICEVOX 未起動時は
 *   ブラウザ標準の speechSynthesis にフォールバックする。
 * - 音声入力: Web Speech API (webkitSpeechRecognition, ja-JP)
 * - 設定パネル / 履歴の復元・検索
 */
const $ = (id) => document.getElementById(id)
const api = window.deepseekChan
const P = window.TextParser
const B = window.AudioBufferTuner
const M = window.AvatarMotion
const StreamingSpeech = window.StreamingSpeech
const TF = window.ThinkingFillers

let audioBufferProfile = (() => {
  try { return B.normalizeAudioBufferProfile(JSON.parse(localStorage.getItem('deepseek-chan-audio-buffer-v1') || 'null')) }
  catch { return B.normalizeAudioBufferProfile(null) }
})()

function tuneAudioBuffer(textLength, rebufferCount) {
  audioBufferProfile = B.adaptAudioBufferProfile(audioBufferProfile, textLength, rebufferCount)
  try { localStorage.setItem('deepseek-chan-audio-buffer-v1', JSON.stringify(audioBufferProfile)) } catch {}
}

let settings = null
let avatar = null // { setMouth, setEmotion, playMotion, kind }
let audioCtx = null
let voicevoxAvailable = false
let speaking = false
const speakQueue = []
let recog = null
let listening = false
let fullMode = false
let previewing = false
let chatSending = false
const turnStarts = new Map()
let activeGenerationId = null
let pendingMotionTurn = null
let motionAudioOwner = null
const audioOutputSchedulers = new WeakMap()
let streamingSpeechGeneration = null
let streamingSpeechChunker = null
let speechQueueWake = null
let speechWorkerPromise = null
let speechWorkerGeneration = null
let prefetchTask = null
let activeAutonomySpeech = false
let activeProactiveSpeechGenerationId = null
let activeFollowUpMemoryId = null
let activeCalendarPresence = null
let calendarPresenceDismissTimer = null
let followUpDismissTimer = null
let calendarSelectedDate = null
let calendarMonthCursor = null
let calendarEditingOccurrence = null
let calendarEditingParent = null
let calendarWritable = true
let calendarEditingTimeZone = null
const cancelledProactiveSpeechIds = new Set()
let activeInterruptPromise = null
const activeAudioSources = new Set()
const activeTtsStreams = new Set()
let ttsWorkerTail = Promise.resolve()
const lastSpeechEndByTurn = new Map()
const playedSpeechGenerations = new Set()
const fillerHandoffs = new Map()
const activeSpeechEmotion = new Map()
const fillerAudioStarted = new Set()
const openingFillerTimers = new Map()
const gapFillerTimers = new Map()
let thinkingFillerCache = null
let thinkingFillerPreparation = null
let activeFillerPlayback = null

function waitMs(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function acquireTtsSlot(generationId, job = null) {
  const previous = ttsWorkerTail
  let unlock
  ttsWorkerTail = new Promise(resolve => { unlock = resolve })
  await previous
  let released = false
  const release = () => {
    if (released) return
    released = true
    unlock()
  }
  if (job?.cancelled) {
    release()
    throw new Error('フィラー音声の準備を中断しました')
  }
  if (generationId && generationId !== activeGenerationId) {
    release()
    const error = new Error('読み上げが中断されました')
    error.name = 'AbortError'
    throw error
  }
  return release
}

async function fillerVoiceFingerprint() {
  const status = await api.voiceStatus()
  if (!status?.available || !status.voiceFingerprint) return null
  const voice = settings?.qwen || {}
  const parts = [status.engine, status.voiceFingerprint, status.sampleRate || 24000,
    settings?.voice?.engine, voice.mode, voice.model, voice.speaker, voice.language,
    voice.instruct, voice.speed, voice.pitch]
  const data = new TextEncoder().encode(JSON.stringify(parts))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function decodeFillerSamples(pcmBase64) {
  const binary = atob(pcmBase64)
  const length = binary.length - binary.length % 2
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const samples = new Float32Array(length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
  return samples
}

function encodeFillerSamples(samples) {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

async function refreshThinkingFillerCache() {
  try {
    const fingerprint = await fillerVoiceFingerprint()
    const key = TF.cacheStorageKey(fingerprint)
    const raw = key ? localStorage.getItem(key) : null
    const saved = raw ? JSON.parse(raw) : null
    thinkingFillerCache = saved?.version === 2 && saved?.voiceFingerprint === fingerprint && saved.sampleRate === 24000
      && saved.clips && typeof saved.clips === 'object' ? saved : { voiceFingerprint:fingerprint, sampleRate:24000, clips:{} }
    const count = Object.keys(thinkingFillerCache.clips).length
    $('thinkingFillerCacheStatus').textContent = count
      ? `現在のQwenの声のキャッシュ ${count} 種類`
      : 'Qwenの声キャッシュは未作成です'
    return thinkingFillerCache
  } catch {
    thinkingFillerCache = null
    if ($('thinkingFillerCacheStatus')) $('thinkingFillerCacheStatus').textContent = '音声キャッシュを読み込めません'
    return null
  }
}

function cancelThinkingFillerPreparation() {
  const job = thinkingFillerPreparation
  if (!job) return
  job.cancelled = true
  if (job.activeStreamId) api.cancelVoiceStream(job.activeStreamId)
  $('thinkingFillerCacheStatus').textContent = '会話を優先して音声キャッシュ作成を中断しました'
}

function synthesizeFillerCachePCM(text, job) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('中断しました'))
    const id = crypto.randomUUID()
    job.activeStreamId = id
    const chunks = []
    let sampleCount = 0
    let carry = null
    let settled = false
    let releaseTtsSlot = null
    const off = api.onVoiceStream(event => {
      if (event.id !== id || settled) return
      if (event.generationId !== job.id || job.cancelled) return fail(new Error('中断しました'))
      if (event.type === 'error') return fail(new Error(event.message || 'Qwen音声を作成できませんでした'))
      if (event.type === 'audio') {
        const input = new Uint8Array(event.chunk)
        const bytes = new Uint8Array(input.length + (carry === null ? 0 : 1))
        let offset = 0
        if (carry !== null) { bytes[0] = carry; offset = 1; carry = null }
        bytes.set(input, offset)
        const even = bytes.length - bytes.length % 2
        if (even !== bytes.length) carry = bytes[even]
        if (!even) return
        const view = new DataView(bytes.buffer, 0, even)
        const samples = new Float32Array(even / 2)
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
        chunks.push(samples)
        sampleCount += samples.length
      } else if (event.type === 'done') {
        if (!sampleCount || carry !== null) return fail(new Error('Qwenから有効な音声データが届きませんでした'))
        settled = true
        clearTimeout(timeout)
        off()
        activeTtsStreams.delete(id)
        releaseTtsSlot?.()
        job.activeStreamId = null
        const samples = new Float32Array(sampleCount)
        let offset = 0
        for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
        resolve(samples)
      }
    })
    const timeout = setTimeout(() => fail(new Error('Qwen音声の作成がタイムアウトしました')), 60000)
    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      off()
      activeTtsStreams.delete(id)
      releaseTtsSlot?.()
      job.activeStreamId = null
      api.cancelVoiceStream(id)
      reject(error)
    }
    const start = async () => {
      try {
        releaseTtsSlot = await acquireTtsSlot(null, job)
        if (settled) { releaseTtsSlot(); return }
        markTtsStreamActive(id)
        api.startVoiceStream(id, text, job.id, 'filler')
      } catch (error) { fail(error) }
    }
    start()
  })
}

async function prepareThinkingFillerCache() {
  if (thinkingFillerPreparation || speaking || chatSending || listening || previewing) return
  if (settings?.voice?.engine !== 'qwen3') {
    $('thinkingFillerCacheStatus').textContent = 'Qwen 3 音声を選択してから作成してください'
    return
  }
  const ids = [...document.querySelectorAll('[data-filler-id]:checked')].map(input => input.dataset.fillerId)
  if (!ids.length) {
    $('thinkingFillerCacheStatus').textContent = 'キャッシュするフィラーを1つ以上選択してください'
    return
  }
  const button = $('btnPrepareThinkingFillers')
  const job = { id:crypto.randomUUID(), cancelled:false, activeStreamId:null }
  thinkingFillerPreparation = job
  button.disabled = true
  try {
    const status = await api.voiceStatus()
    if (job.cancelled || speaking || chatSending || listening || previewing) throw new Error('会話を優先して音声キャッシュ作成を中断しました')
    if (!status?.available || !status.voiceFingerprint) throw new Error('Qwenの音声サーバーが準備できていません')
    const fingerprintData = new TextEncoder().encode(JSON.stringify([status.engine, status.voiceFingerprint,
      status.sampleRate || 24000, settings.voice.engine, settings.qwen.mode, settings.qwen.model,
      settings.qwen.speaker, settings.qwen.language, settings.qwen.instruct, settings.qwen.speed, settings.qwen.pitch]))
    const digest = await crypto.subtle.digest('SHA-256', fingerprintData)
    const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
    const key = TF.cacheStorageKey(fingerprint)
    const cached = JSON.parse(localStorage.getItem(key) || 'null')
    const store = cached?.version === 2 && cached?.voiceFingerprint === fingerprint && cached.sampleRate === 24000
      ? cached : { version:2, voiceFingerprint:fingerprint, sampleRate:24000, clips:{} }
    const rejected = []
    for (const id of ids) {
      if (job.cancelled) throw new Error('会話を優先して中断しました')
      if (store.clips[id]?.pcmBase64) continue
      const phrase = TF.FILLER_PHRASES.find(row => row.id === id)
      if (!phrase) continue
      $('thinkingFillerCacheStatus').textContent = `「${phrase.text}」を現在のQwenの声で作成中…`
      const samples = await synthesizeFillerCachePCM(phrase.text, job)
      if (job.cancelled) throw new Error('会話を優先して中断しました')
      const quality = TF.analyzeFillerSamples(samples, store.sampleRate)
      recordMetric('filler.cache_quality', null, {
        phraseIndex:TF.FILLER_PHRASES.findIndex(row => row.id === id),
        tokenBudget:TF.fillerTokenBudget(phrase.text), totalMs:samples.length / store.sampleRate * 1000,
        speechMs:quality.activeDurationMs || 0, leadingSilenceMs:quality.leadingSilenceMs || 0,
        trailingSilenceMs:quality.trailingSilenceMs || 0, peakRms:quality.peakRms || 0,
        clippedRatio:quality.clippedRatio || 0, accepted:quality.accepted ? 1 : 0,
      })
      if (!quality.accepted) {
        rejected.push({ id, reason:quality.reason, speechMs:quality.activeDurationMs || 0 })
        continue
      }
      store.clips[id] = { pcmBase64:encodeFillerSamples(quality.samples), sampleCount:quality.samples.length,
        speechDurationMs:quality.activeDurationMs, tokenBudget:TF.fillerTokenBudget(phrase.text) }
      localStorage.setItem(key, JSON.stringify(store))
    }
    thinkingFillerCache = store
    const savedCount = Object.keys(store.clips).length
    $('thinkingFillerCacheStatus').textContent = rejected.length
      ? `${savedCount}種類を保存、${rejected.length}種類は長さ・音質で除外しました（0.55〜1.5秒を目安）`
      : `現在のQwenの声で ${savedCount} 種類を保存しました`
  } catch (error) {
    $('thinkingFillerCacheStatus').textContent = error.message || '音声キャッシュの作成に失敗しました'
  } finally {
    if (thinkingFillerPreparation === job) thinkingFillerPreparation = null
    button.disabled = false
  }
}

function reportPresence(patch) {
  try { api.reportPresence(patch) } catch {}
}

function reportAudioPresence(isActive) {
  reportPresence({ speaking:isActive === true || speaking })
}

function wakeSpeechQueue() {
  const wake = speechQueueWake
  speechQueueWake = null
  wake?.()
}

function incrementE2EProbe(key) {
  if (window.__deepseekE2EProbe) window.__deepseekE2EProbe[key] = (window.__deepseekE2EProbe[key] || 0) + 1
}

function markTtsStreamActive(id) {
  activeTtsStreams.add(id)
  if (window.__deepseekE2EProbe) {
    window.__deepseekE2EProbe.maxActiveTtsStreams = Math.max(window.__deepseekE2EProbe.maxActiveTtsStreams || 0, activeTtsStreams.size)
  }
}

function addSpeechPlans(plans, generationId = null) {
  if (generationId && generationId !== activeGenerationId) return
  if (plans.length && generationId) incrementE2EProbe('queuedPlans')
  if (plans.length && generationId && streamingSpeechGeneration === generationId) {
    const startedAt = turnStarts.get(generationId)
    recordMetric('speech.plan_ready', generationId, {
      elapsedMs: startedAt === undefined ? 0 : elapsedSince(startedAt),
      planCount: plans.length,
      textChars: plans.reduce((sum, plan) => sum + [...plan.text].length, 0),
    })
  }
  for (const plan of plans) {
    plan.generationId = generationId
    if (generationId) plan.turnId = generationId
    speakQueue.push(plan)
  }
  if (plans.length) {
    wakeSpeechQueue()
    processSpeakQueue(generationId).catch((e) => console.error(e))
    maybeStartPrefetch(generationId)
  }
}

function stopActiveAudio() {
  try { speechSynthesis.cancel() } catch {}
  for (const timer of openingFillerTimers.values()) clearTimeout(timer)
  for (const timer of gapFillerTimers.values()) clearTimeout(timer)
  openingFillerTimers.clear()
  gapFillerTimers.clear()
  if (activeFillerPlayback) {
    const filler = activeFillerPlayback
    activeFillerPlayback = null
    if (settings?.features?.motionArbitration === true) avatar?.cancelMotionSource?.('filler')
    clearInterval(filler.mouthTimer)
      clearAudioTimer(filler.outputTimer)
      clearTimeout(filler.startTimeout)
    try { filler.gain.gain.cancelScheduledValues(filler.ctx.currentTime); filler.gain.gain.setValueAtTime(0, filler.ctx.currentTime) } catch {}
    try { filler.source.stop() } catch {}
    try { filler.source.disconnect(); filler.analyser.disconnect(); filler.gain.disconnect() } catch {}
    activeAudioSources.delete(filler.source)
  }
  for (const source of activeAudioSources) {
    try { source.stop() } catch {}
    try { source.__deepseekResolvePlayback?.() } catch {}
  }
  activeAudioSources.clear()
  if (settings?.features?.motionArbitration === true) motionAudioOwner = null
  avatar?.setSpeaking?.(false)
  avatar?.setMouth(0)
  reportAudioPresence(false)
}

function fillerHistory() {
  try {
    const value = JSON.parse(localStorage.getItem('deepseek-chan-filler-history-v1') || '[]')
    return Array.isArray(value) ? value.filter(item => Number.isFinite(item?.at) && typeof item?.id === 'string').slice(-8) : []
  } catch { return [] }
}

function selectCachedFiller(position) {
  const config = TF.normalizeThinkingFillers(settings?.thinkingFillers)
  const cachedIds = Object.keys(thinkingFillerCache?.clips || {})
  const phrase = TF.selectFiller({ config, position, cachedIds, history:fillerHistory(),
    random:window.__deepseekE2EProbe ? () => 0 : Math.random })
  return phrase ? { phrase, samples:decodeFillerSamples(thinkingFillerCache.clips[phrase.id].pcmBase64) } : null
}

function rememberFiller(phrase) {
  const history = [...fillerHistory(), { id:phrase.id, at:Date.now() }].slice(-8)
  try { localStorage.setItem('deepseek-chan-filler-history-v1', JSON.stringify(history)) } catch {}
}

function cancelUnstartedFiller(source) {
  const filler = activeFillerPlayback
  if (!filler || filler.source !== source) return false
  activeFillerPlayback = null
  clearInterval(filler.mouthTimer)
  clearAudioTimer(filler.outputTimer)
  clearTimeout(filler.startTimeout)
  activeAudioSources.delete(source)
  avatar?.cancelMotionSource?.('filler', filler.generationId)
  if (motionAudioOwner === source) {
    motionAudioOwner = null
    avatar?.setSpeaking?.(false)
    avatar?.setMouth(0)
  }
  try { source.stop() } catch {}
  try { source.disconnect(); filler.analyser.disconnect(); filler.gain.disconnect() } catch {}
  reportAudioPresence(activeAudioSources.size > 0)
  return true
}

function startCachedFiller(generationId, position) {
  if (!settings?.thinkingFillers?.enabled || !settings.features?.lowLatencySpeech || !settings.voice.enabled
      || generationId !== activeGenerationId || activeFillerPlayback || fillerAudioStarted.has(`${generationId}:${position}`)) return false
  if ([...fillerAudioStarted].filter(key => key.startsWith(`${generationId}:`)).length >= 2) return false
  const upcomingEmotion = activeSpeechEmotion.get(generationId)
  if (upcomingEmotion && !['neutral', 'thinking', 'confused'].includes(upcomingEmotion)) return false
  const selected = selectCachedFiller(position)
  if (!selected?.samples.length) return false
  const ctx = ensureAudio()
  const guardedMotion = settings?.features?.motionArbitration === true
  const resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
  if (!guardedMotion) resume.catch(() => {})
  if (generationId !== activeGenerationId) return false
  const audio = ctx.createBuffer(1, selected.samples.length, thinkingFillerCache.sampleRate || 24000)
  audio.copyToChannel(selected.samples, 0)
  const source = ctx.createBufferSource()
  const analyser = ctx.createAnalyser()
  const gain = ctx.createGain()
  analyser.fftSize = 512
  source.buffer = audio
  source.connect(analyser)
  analyser.connect(gain)
  gain.connect(ctx.destination)
  gain.gain.value = 1
  const startAt = ctx.currentTime + (guardedMotion ? 0.02 : 0)
  source.onended = () => {
    if (activeFillerPlayback?.source !== source) return
    const filler = activeFillerPlayback
    activeFillerPlayback = null
    if (settings?.features?.motionArbitration === true) avatar?.cancelMotionSource?.('filler')
    clearInterval(filler.mouthTimer)
    clearAudioTimer(filler.outputTimer)
    clearTimeout(filler.startTimeout)
    activeAudioSources.delete(source)
    try { source.disconnect(); analyser.disconnect(); gain.disconnect() } catch {}
    if (generationId === activeGenerationId && !filler.transitioning) {
      if (ownsMotionAudio(source, generationId)) {
        avatar?.setSpeaking?.(false)
        avatar?.setMouth(0)
        if (motionAudioOwner === source) motionAudioOwner = null
        setAvatarState('thinking')
      }
    } else if (generationId === activeGenerationId && settings?.features?.motionArbitration === true
        && motionAudioOwner === source) {
      motionAudioOwner = null
      avatar?.setSpeaking?.(false)
      avatar?.setMouth(0)
    }
    reportAudioPresence(settings?.features?.motionArbitration === true ? activeAudioSources.size > 0 : false)
  }
  const levels = new Uint8Array(analyser.frequencyBinCount)
  const updateMouth = () => {
    if (generationId !== activeGenerationId) return
    if (settings?.features?.motionArbitration === true && ctx.state !== 'running') {
      if (motionAudioOwner === source) { avatar?.setSpeaking?.(false); avatar?.setMouth(0) }
      return
    }
    if (settings?.features?.motionArbitration === true && !motionAudioOwner && hasAudioOutputReached(ctx, startAt)
        && claimMotionAudio(source, generationId)) avatar?.setSpeaking?.(true)
    if (settings?.features?.motionArbitration === true && (!ownsMotionAudio(source, generationId) || !hasAudioOutputReached(ctx, startAt))) return
    if (settings?.features?.motionArbitration === true && motionAudioOwner === source) {
      avatar?.setSpeaking?.(true)
      if (activeFillerPlayback?.source === source && !activeFillerPlayback.motionStarted) {
        activeFillerPlayback.motionStarted = true
        avatar?.playMotion('think', { source:'filler', generationId })
      }
    }
    if (!ownsMotionAudio(source, generationId)) return
    analyser.getByteTimeDomainData(levels)
    let sum = 0
    for (const value of levels) { const sample = (value - 128) / 128; sum += sample * sample }
    avatar?.setMouth(Math.min(1, Math.sqrt(sum / levels.length) * 3.2))
  }
  activeFillerPlayback = { ctx, source, analyser, gain, generationId, phrase:selected.phrase, position,
    samples:selected.samples, sampleRate:thinkingFillerCache.sampleRate || 24000, startedAtCtx:startAt,
    transitioning:false, motionStarted:!guardedMotion, mouthTimer:setInterval(updateMouth, 50), outputTimer:null, startTimeout:null }
  if (guardedMotion) {
    activeFillerPlayback.outputTimer = scheduleAtAudioOutput(ctx, startAt, updateMouth)
    activeFillerPlayback.startTimeout = setTimeout(() => {
      if (activeFillerPlayback?.source === source && !hasAudioOutputReached(ctx, startAt)) cancelUnstartedFiller(source)
    }, 5000)
  } else claimMotionAudio(source, generationId)
  if (settings.features?.silentReactions === true) clearSilentReaction()
  activeAudioSources.add(source)
  fillerAudioStarted.add(`${generationId}:${position}`)
  rememberFiller(selected.phrase)
  setAvatarState('thinking')
  if (!guardedMotion) avatar?.playMotion('think', { source:'filler', generationId })
  if (settings?.features?.motionArbitration !== true) avatar?.setSpeaking?.(true)
  reportAudioPresence(true)
  recordMetric('filler.started', generationId, { elapsedMs:elapsedSince(turnStarts.get(generationId) || performance.now()), phraseIndex:TF.FILLER_PHRASES.findIndex(row => row.id === selected.phrase.id), position })
  if (window.__deepseekE2EProbe) {
    incrementE2EProbe('fillerStarts')
    incrementE2EProbe(position === 'gap' ? 'fillerGapStarts' : 'fillerOpeningStarts')
    if (chatSending && activeTtsStreams.size) incrementE2EProbe('fillerWhileTtsAndLlm')
    const startedAt = turnStarts.get(generationId)
    if (Number.isFinite(startedAt)) window.__deepseekE2EProbe.fillerStartElapsedMs.push({
      position, elapsedMs:elapsedSince(startedAt), ttsActive:activeTtsStreams.size > 0, llmActive:chatSending,
    })
    window.__deepseekE2EProbe.fillerTtsActiveAtStart = Math.max(window.__deepseekE2EProbe.fillerTtsActiveAtStart || 0, activeTtsStreams.size)
    window.__deepseekE2EProbe.fillerChatSendingAtStart = window.__deepseekE2EProbe.fillerChatSendingAtStart || chatSending
  }
  if (guardedMotion) source.start(startAt)
  else source.start()
  if (guardedMotion) resume.catch(() => cancelUnstartedFiller(source))
  return true
}

function finishFillerForAnswer(generationId) {
  if (!activeFillerPlayback || activeFillerPlayback.generationId !== generationId) return 0
  const filler = activeFillerPlayback
  filler.transitioning = true
  const now = filler.ctx.currentTime
  const fromSample = Math.max(0, Math.floor((now - filler.startedAtCtx) * filler.sampleRate))
  const boundarySample = TF.findQuietBoundary(filler.samples, fromSample, filler.sampleRate, 120, 0.008)
  const boundaryWait = boundarySample === null ? Infinity : Math.max(0, (boundarySample - fromSample) / filler.sampleRate)
  const transitionStyle = boundaryWait <= 0.08 ? 'natural' : 'fade'
  const fadeStart = transitionStyle === 'natural' ? now + boundaryWait : now
  const fadeMs = transitionStyle === 'natural' ? 0.025 : 0.05
  const endAt = fadeStart + fadeMs
  try {
    filler.gain.gain.cancelScheduledValues(fadeStart)
    filler.gain.gain.setValueAtTime(filler.gain.gain.value, fadeStart)
    filler.gain.gain.linearRampToValueAtTime(0, endAt)
    filler.source.stop(endAt)
  } catch { try { filler.source.stop() } catch {} }
  fillerHandoffs.set(generationId, { endAt, position:filler.position, transitionStyle })
  return endAt
}

function recordFillerHandoff(generationId, answerStartAt) {
  const handoff = fillerHandoffs.get(generationId)
  if (!handoff) return
  const gapMs = Math.max(0, (answerStartAt - handoff.endAt) * 1000)
  recordMetric('filler.transition', generationId, { gapMs, position:handoff.position, transitionStyle:handoff.transitionStyle })
  if (window.__deepseekE2EProbe) window.__deepseekE2EProbe.fillerHandoffGapsMs.push(gapMs)
  incrementE2EProbe('fillerTransitions')
  incrementE2EProbe(handoff.position === 'gap' ? 'fillerGapTransitions' : 'fillerOpeningTransitions')
  fillerHandoffs.delete(generationId)
}

function scheduleOpeningFiller(generationId) {
  const config = TF.normalizeThinkingFillers(settings?.thinkingFillers)
  if (!config.enabled || config.mode === 'none' || !settings.features?.lowLatencySpeech || !settings.voice?.enabled
      || generationId !== activeGenerationId || !Object.keys(thinkingFillerCache?.clips || {}).length) return
  const timer = setTimeout(() => {
    openingFillerTimers.delete(generationId)
    if (generationId !== activeGenerationId || playedSpeechGenerations.has(generationId) || fillerAudioStarted.has(`${generationId}:opening`)
        || fillerAudioStarted.has(`${generationId}:gap`)) return
    startCachedFiller(generationId, 'opening')
  }, config.startDelayMs)
  openingFillerTimers.set(generationId, timer)
}

function scheduleGapFiller(generationId) {
  const config = TF.normalizeThinkingFillers(settings?.thinkingFillers)
  if (config.mode !== 'opening-gap' || !config.enabled || !settings.features?.lowLatencySpeech
      || generationId !== activeGenerationId || !Object.keys(thinkingFillerCache?.clips || {}).length) return null
  const timer = setTimeout(() => {
    gapFillerTimers.delete(generationId)
    startCachedFiller(generationId, 'gap')
  }, 650)
  gapFillerTimers.set(generationId, timer)
  return timer
}

function cancelGapFillerTimer(generationId) {
  const timer = gapFillerTimers.get(generationId)
  if (timer) clearTimeout(timer)
  gapFillerTimers.delete(generationId)
}

function interruptActiveTurn({ preservePending = false } = {}) {
  const cancelledPendingTurn = preservePending ? null : pendingMotionTurn
  if (!preservePending) pendingMotionTurn = null
  if (activeInterruptPromise) {
    if (cancelledPendingTurn && settings?.features?.motionArbitration === true) avatar?.cancelMotionTurn?.(cancelledPendingTurn)
    return activeInterruptPromise
  }
  const interruptedId = activeGenerationId
  if (!interruptedId && !speechWorkerPromise && !speaking && !activeFillerPlayback) {
    if (cancelledPendingTurn && settings?.features?.motionArbitration === true) avatar?.cancelMotionTurn?.(cancelledPendingTurn)
    return Promise.resolve()
  }
  const run = (async () => {
    incrementE2EProbe('interrupts')
    if (settings?.features?.motionArbitration === true) {
      if (interruptedId) avatar?.cancelMotionTurn?.(interruptedId)
      if (cancelledPendingTurn && cancelledPendingTurn !== interruptedId) avatar?.cancelMotionTurn?.(cancelledPendingTurn)
    }
    if (interruptedId) activeGenerationId = null
    if (interruptedId && interruptedId === activeProactiveSpeechGenerationId) {
      activeProactiveSpeechGenerationId = null
      activeFollowUpMemoryId = null
      api.finishProactiveSpeech(interruptedId).catch(() => {})
    }
    activeAutonomySpeech = false
    streamingSpeechGeneration = null
    streamingSpeechChunker = null
    speakQueue.length = 0
    wakeSpeechQueue()
    if (interruptedId) {
      api.cancelChat(interruptedId)
      api.cancelVoiceGeneration(interruptedId)
      for (const timer of [openingFillerTimers.get(interruptedId), gapFillerTimers.get(interruptedId)]) if (timer) clearTimeout(timer)
      openingFillerTimers.delete(interruptedId)
      gapFillerTimers.delete(interruptedId)
      playedSpeechGenerations.delete(interruptedId)
      fillerHandoffs.delete(interruptedId)
      activeSpeechEmotion.delete(interruptedId)
      for (const key of fillerAudioStarted) if (key.startsWith(`${interruptedId}:`)) fillerAudioStarted.delete(key)
    }
    stopActiveAudio()
    if (prefetchTask?.generationId === interruptedId) prefetchTask = null
    const worker = speechWorkerPromise
    if (worker) { try { await worker } catch {} }
    avatar?.releaseEmotion?.()
    setAvatarState('idle')
  })()
  activeInterruptPromise = run
  const clear = () => { if (activeInterruptPromise === run) activeInterruptPromise = null }
  run.then(clear, clear)
  return run
}

function recordMetric(event, turnId, fields = {}) {
  try { api.recordPerformanceMetric(event, turnId, fields).catch(() => {}) } catch {}
}

function elapsedSince(startedAt) {
  return Math.max(0, performance.now() - startedAt)
}

function startRenderPerformanceSampler() {
  let frames = 0
  let sampleStarted = performance.now()
  const frame = (now) => {
    frames++
    const elapsed = now - sampleStarted
    if (elapsed >= 10000) {
      const jsHeapMB = performance.memory?.usedJSHeapSize / (1024 * 1024)
      recordMetric('render.sample', null, { fps: frames * 1000 / elapsed, ...(Number.isFinite(jsHeapMB) ? { jsHeapMB } : {}) })
      frames = 0
      sampleStarted = now
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/* ---------------- アバター ---------------- */

async function initAvatar() {
  avatar?.dispose?.()
  avatar = null
  const container = $('vrmContainer')
  container.style.display = 'block'
  $('pngCanvas').style.display = 'none'
  $('pngFallback').style.display = 'none'
  try {
    const live = new window.Live2DAvatar(container)
    await live.load('../assets/live2d/大肥鱼.model3.json')
    live.kind = 'live2d'
    live.setMotionAmount(settings.avatar.motionAmount ?? 0.7)
    live.setNaturalIdleEnabled(settings.features?.live2dNaturalIdle === true)
    live.setEmotionPersistenceEnabled(settings.features?.emotionPersistence === true)
    live.setMotionArbitrationEnabled(settings.features?.motionArbitration === true)
    avatar = live
    if (settings.features?.motionArbitration === true) {
      if (activeGenerationId) live.beginMotionTurn(activeGenerationId)
      if (motionAudioOwner) { live.setState('speaking'); live.setSpeaking(true) }
      else if (activeGenerationId && chatSending) live.setState('thinking')
    }
    applySelectedEmotion()
    setStatus('Live2Dモデル表示中')
    console.log('[avatar] Live2D loaded OK')
  } catch (e) {
    console.error('[avatar] Live2D failed', e)
    setStatus('Live2Dの読み込みエラー')
    addSystemMessage('Live2Dモデルを読み込めませんでした: ' + (e.message || e))
  }
}
let automaticEmotion = { name: 'neutral', intensity: undefined }
function applySelectedEmotion() {
  const selected = $('faceSelect').value
  const name = selected === 'auto' ? automaticEmotion.name : selected
  const intensity = selected === 'auto' ? automaticEmotion.intensity : 1
  avatar?.setEmotion(name, intensity)
  const labels = { neutral: '通常', happy: '喜び', shy: '照れ', excited: '興奮', thinking: '思考', sleepy: '眠気', proud: '得意げ', sad: '悲しみ', annoyed: '不満', surprised: '驚き', greeting: '挨拶', playful: 'いたずら', flustered: '慌てる', confused: '困惑', pout: '拗ねる', angry: 'おこり', relaxed: 'おだやか', worried: 'しんぱい', loving: 'だいすき', crying: 'なみだ' }
  $('emotionLabel').textContent = labels[name] || ''
}
function setEmotion(name, intensity) {
  automaticEmotion = { name, intensity }
  applySelectedEmotion()
  if ($('faceSelect').value === 'auto' && ['proud', 'surprised', 'confused'].includes(name)) showSilentBubble(name)
}

function finishEmotionAfterSpeech() {
  if (settings.features?.emotionPersistence === true && $('faceSelect').value === 'auto') {
    automaticEmotion = { name: 'neutral', intensity: 0 }
    avatar?.releaseEmotion?.()
    $('emotionLabel').textContent = '通常'
    return
  }
  setEmotion('neutral')
}

const silentLimiter = new window.SilentReactions.Limiter()
let silentBubblePending = false
let silentNod = null
let lastSilentNodAt = -Infinity
function hideSilentBubble() {
  silentLimiter.invalidate()
  const bubble = $('silentReactionBubble')
  bubble.classList.remove('visible')
  bubble.hidden = true
}
function clearSilentReaction() {
  hideSilentBubble()
  if (silentNod && avatar?.nod === silentNod) avatar.nod = null
  silentNod = null
}
async function showSilentBubble(kind) {
  if (settings?.features?.silentReactions !== true || settings.autonomy?.focusMode || speaking || activeFillerPlayback || silentBubblePending) return
  const ticket = silentLimiter.ticket()
  const turnId = activeGenerationId
  const state = avatar?.state
  const desktopEnabled = settings.desktopContext?.enabled === true
  silentBubblePending = true
  try {
    if (!await api.silentReactionAllowed()) return
    if (settings?.features?.silentReactions !== true || settings.autonomy?.focusMode || speaking || activeFillerPlayback || ticket !== silentLimiter.ticket()
        || activeGenerationId !== turnId || avatar?.state !== state || (settings.desktopContext?.enabled === true) !== desktopEnabled) return
    const area = $('avatarArea').getBoundingClientRect()
    const chat = $('chatLog').getBoundingClientRect()
    if (chat.top - area.top < 52) return
    if (!silentLimiter.allow(kind, performance.now(), ticket)) return
    const bubble = $('silentReactionBubble')
    bubble.textContent = window.SilentReactions.labels[kind]
    bubble.hidden = false
    bubble.classList.remove('visible')
    void bubble.offsetWidth
    bubble.classList.add('visible')
  } catch {} finally { silentBubblePending = false }
}
function applyAvatarState(state) {
  avatar?.setState?.(state)
  if (settings?.features?.silentReactions !== true) return
  if (state === 'thinking') showSilentBubble('thinking')
  else if (state === 'idle' || state === 'speaking') clearSilentReaction()
  else hideSilentBubble()
}
const instantReaction = new window.InstantReaction.Controller({ setState: applyAvatarState })
function setAvatarState(state) {
  if (settings?.features?.instantReaction === true) instantReaction.transition(state)
  else applyAvatarState(state)
}

function claimMotionAudio(owner, generationId) {
  if (settings?.features?.motionArbitration !== true) return true
  if (generationId && generationId !== activeGenerationId) return false
  motionAudioOwner = owner
  return true
}
function ownsMotionAudio(owner, generationId) {
  return settings?.features?.motionArbitration !== true || ((!generationId || generationId === activeGenerationId) && (!motionAudioOwner || motionAudioOwner === owner))
}
function audioOutputContextTime(ctx) {
  if (!ctx || ctx.state !== 'running') return null
  if (typeof ctx.getOutputTimestamp === 'function') {
    try {
      const timestamp = ctx.getOutputTimestamp()
      if (Number.isFinite(timestamp?.contextTime)) return timestamp.contextTime
    } catch {}
  }
  return Number.isFinite(ctx.currentTime) ? ctx.currentTime : null
}
function hasAudioOutputReached(ctx, scheduledAt) {
  const outputTime = audioOutputContextTime(ctx)
  return outputTime !== null && outputTime >= scheduledAt
}
function scheduleAtAudioOutput(ctx, scheduledAt, callback) {
  let scheduler = audioOutputSchedulers.get(ctx)
  if (!scheduler) {
    scheduler = { pending:new Map(), interval:null }
    audioOutputSchedulers.set(ctx, scheduler)
  }
  const handle = { cancel:() => {
    scheduler.pending.delete(handle)
    if (!scheduler.pending.size && scheduler.interval !== null) {
      clearInterval(scheduler.interval)
      scheduler.interval = null
      audioOutputSchedulers.delete(ctx)
    }
  } }
  scheduler.pending.set(handle, { scheduledAt, callback })
  if (scheduler.interval === null) scheduler.interval = setInterval(() => {
    const outputTime = audioOutputContextTime(ctx)
    if (outputTime !== null) {
      for (const [queued, event] of scheduler.pending) {
        if (outputTime < event.scheduledAt) continue
        scheduler.pending.delete(queued)
        event.callback()
      }
    }
    if (!scheduler.pending.size && scheduler.interval !== null) {
      clearInterval(scheduler.interval)
      scheduler.interval = null
      audioOutputSchedulers.delete(ctx)
    }
  }, 20)
  return handle
}
function clearAudioTimer(timer) {
  if (timer && typeof timer.cancel === 'function') timer.cancel()
  else clearTimeout(timer)
}

/* ---------------- 音声再生＋口パク ---------------- */

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

async function playWav(uint8) {
  const ctx = ensureAudio()
  const buf = await ctx.decodeAudioData(uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength))
  const src = ctx.createBufferSource()
  src.buffer = buf
  avatar?.setSpeaking?.(true)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  src.connect(analyser)
  analyser.connect(ctx.destination)
  const data = new Uint8Array(analyser.frequencyBinCount)
  let raf = 0
  const tick = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    avatar?.setMouth(Math.min(1, rms * 3.2))
    raf = requestAnimationFrame(tick)
  }
  tick()
  await new Promise((resolve) => {
    src.onended = resolve
    src.start()
  })
  cancelAnimationFrame(raf)
  src.disconnect()
  analyser.disconnect()
  avatar?.setSpeaking?.(false)
  avatar?.setMouth(0)
}

// Buffer enough audio to keep CPU synthesis fluctuations from fragmenting speech.
async function playFastVoice(text, motion, emotion, intensity, cues = [], waitForComplete = false, turnId = null,
  generationId = activeGenerationId, onPlaybackStarted = null) {
  const ctx = ensureAudio()
  if (ctx.state === 'suspended') await ctx.resume()
  const id = crypto.randomUUID()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.connect(ctx.destination)
  const levels = new Uint8Array(analyser.frequencyBinCount)
  let carry = null, pending = [], bufferedSamples = 0, running = false
  let nextTime = 0, active = 0, received = false, ended = false, settled = false, mouthTimer = 0, startedPlayback = false
  let firstAudioLogged = false, firstPlaybackScheduled = false, playbackStartAt = null, playbackPoll = 0
  let scheduledDuration = 0, cueIndex = 0
  let playbackNotBefore = 0
  let streamDoneAt = null, lastAudioChunkAt = null
  let releaseTtsSlot = null
  const chunkIntervalsMs = [], rebufferGapsMs = [], scheduledGapsMs = []
  const cueTimers = new Set()
  const requestStartedAt = performance.now()
  incrementE2EProbe('voiceRequests')
  window.__fastVoiceMetrics = {chunks:0, playbackBatches:0, maxPcm:0, rebufferCount:0, firstPlaybackSeconds:null}
  const sources = new Set()
  const timedCues = [...cues, ...M.buildSpeechMotionCues(text)].sort((a, b) => a.offset - b.offset)
  if (timedCues[0]?.offset === 0) cueIndex = 1
  const defaultInitialBufferSeconds = B.getInitialAudioBufferSeconds([...text].length, audioBufferProfile)
  const initialBufferSeconds = defaultInitialBufferSeconds
  const initialSamples = 24000 * initialBufferSeconds
  let recoverySamples = 0
  const batchSamples = 24000 * 0.4
  return await new Promise((resolve, reject) => {
    const off = api.onVoiceStream(onEvent)
    const timeout = setTimeout(() => fail(new Error('音声生成に時間がかかりすぎました')), 300000)
    function cleanup() {
      clearTimeout(timeout); off(); clearInterval(mouthTimer); clearAudioTimer(playbackPoll)
      activeTtsStreams.delete(id)
      for (const timer of cueTimers) clearAudioTimer(timer)
      for (const source of sources) activeAudioSources.delete(source)
      analyser.disconnect()
      if (ownsMotionAudio(id, generationId)) {
        avatar?.setSpeaking?.(false); avatar?.setMouth(0)
        if (motionAudioOwner === id) motionAudioOwner = null
      }
      reportAudioPresence(false)
    }
    function fail(error) {
      if (settled) return
      settled = true
      api.cancelVoiceStream(id)
      releaseTtsSlot?.()
      for (const source of sources) { try { source.stop() } catch {}; activeAudioSources.delete(source) }
      cleanup(); reject(error)
    }
    function maybeDone() {
      if (!settled && ended && active === 0 && bufferedSamples === 0) {
        const rebufferCount = window.__fastVoiceMetrics.rebufferCount
        const chunkGaps = B.summarizeIntervals(chunkIntervalsMs)
        const generationElapsedMs = Math.max(0, (streamDoneAt || performance.now()) - requestStartedAt)
        recordMetric('audio.stream_completed', turnId, {
          elapsedMs: turnId && turnStarts.has(turnId) ? elapsedSince(turnStarts.get(turnId)) : elapsedSince(requestStartedAt),
          generationElapsedMs,
          audioSeconds: scheduledDuration,
          rebufferCount,
          chunkCount:window.__fastVoiceMetrics.chunks,
          chunkGapMedianMs:chunkGaps.medianMs,
          chunkGapP95Ms:chunkGaps.p95Ms,
          chunkGapMaxMs:chunkGaps.maxMs,
          generationRealtimeFactor:generationElapsedMs ? scheduledDuration * 1000 / generationElapsedMs : 0,
          maxRebufferGapMs:Math.max(0, ...rebufferGapsMs),
          scheduledGapCount:scheduledGapsMs.filter(gap => gap > 25).length,
        })
        if (generationId || turnId) {
          lastSpeechEndByTurn.set(generationId || turnId, ctx.currentTime)
          while (lastSpeechEndByTurn.size > 40) lastSpeechEndByTurn.delete(lastSpeechEndByTurn.keys().next().value)
        }
        tuneAudioBuffer([...text].length, rebufferCount)
        settled = true; cleanup(); resolve()
      }
    }
    function updateMouth() {
      if (settings?.features?.motionArbitration === true && ctx.state !== 'running') {
        if (motionAudioOwner === id) { avatar?.setSpeaking?.(false); avatar?.setMouth(0) }
        return
      }
      if (settings?.features?.motionArbitration === true && !motionAudioOwner && playbackStartAt !== null && hasAudioOutputReached(ctx, playbackStartAt)
          && claimMotionAudio(id, generationId)) { setAvatarState('speaking'); avatar?.setSpeaking?.(true) }
      if (settings?.features?.motionArbitration === true && motionAudioOwner !== id) return
      if (settings?.features?.motionArbitration === true && motionAudioOwner === id) avatar?.setSpeaking?.(true)
      if (!ownsMotionAudio(id, generationId)) return
      analyser.getByteTimeDomainData(levels)
      let sum = 0
      for (const value of levels) { const v = (value - 128) / 128; sum += v * v }
      avatar?.setMouth(Math.min(1, Math.sqrt(sum / levels.length) * 3.2))
    }
    function schedule(samples) {
      const audio = ctx.createBuffer(1, samples.length, 24000)
      audio.copyToChannel(samples, 0)
      const source = ctx.createBufferSource()
      source.buffer = audio
      source.connect(analyser)
      sources.add(source); activeAudioSources.add(source); active++
      window.__fastVoiceMetrics.playbackBatches++
      source.onended = () => { sources.delete(source); active--; source.disconnect(); maybeDone() }
      if (nextTime && nextTime <= ctx.currentTime) {
        const gapMs = (ctx.currentTime - nextTime) * 1000
        if (gapMs > 25) scheduledGapsMs.push(gapMs)
      }
      if (!nextTime || nextTime <= ctx.currentTime) nextTime = Math.max(ctx.currentTime + 0.04, playbackNotBefore)
      if (scheduledDuration === 0 && generationId) recordFillerHandoff(generationId, nextTime)
      if (scheduledDuration === 0 && (generationId || turnId)) {
        const sequenceId = generationId || turnId
        const previousEnd = lastSpeechEndByTurn.get(sequenceId)
        if (Number.isFinite(previousEnd)) recordMetric('audio.sentence_boundary', sequenceId, {
          gapMs:Math.max(0, (nextTime - previousEnd) * 1000), audioSeconds:0,
        })
        lastSpeechEndByTurn.delete(sequenceId)
      }
      if (!firstPlaybackScheduled) {
        firstPlaybackScheduled = true
        playbackStartAt = nextTime
        recordMetric('audio.first_scheduled', turnId, {
          elapsedMs: turnId && turnStarts.has(turnId) ? elapsedSince(turnStarts.get(turnId)) : elapsedSince(requestStartedAt),
          scheduledLeadMs: Math.max(0, (nextTime - ctx.currentTime) * 1000),
        })
        const onOutputStarted = clockSource => {
          if (settings?.features?.motionArbitration === true && !settled && claimMotionAudio(id, generationId)) {
            avatar?.cancelMotionSource?.('filler')
            if (emotion) setEmotion(emotion, intensity)
            setAvatarState('speaking')
            avatar?.setSpeaking?.(true)
            if (motion) avatar?.playMotion(motion, { source:'speech', generationId })
          }
          recordMetric('audio.output_started', turnId, {
            elapsedMs: turnId && turnStarts.has(turnId) ? elapsedSince(turnStarts.get(turnId)) : elapsedSince(requestStartedAt),
            clockSource,
          })
        }
        if (settings?.features?.motionArbitration === true) {
          playbackPoll = scheduleAtAudioOutput(ctx, playbackStartAt, () => onOutputStarted(
            typeof ctx.getOutputTimestamp === 'function' ? 'audio-output' : 'audio-context'))
        } else {
          playbackPoll = setInterval(() => {
            let outputTime = ctx.currentTime
            let clockSource = 'audio-context'
            if (typeof ctx.getOutputTimestamp === 'function') {
              try {
                const timestamp = ctx.getOutputTimestamp()
                if (Number.isFinite(timestamp?.contextTime)) { outputTime = timestamp.contextTime; clockSource = 'audio-output' }
              } catch {}
            }
            if (outputTime < playbackStartAt) return
            clearInterval(playbackPoll)
            onOutputStarted(clockSource)
          }, 20)
        }
      }
      // The speech engine does not supply word timings; these are estimates.
      const cueTime = cue => waitForComplete
        ? cue.offset / Math.max(1, [...text].length) * audio.duration
        : cue.offset / 5.5
      while (cueIndex < timedCues.length && cueTime(timedCues[cueIndex]) < scheduledDuration + audio.duration) {
        const cue = timedCues[cueIndex++]
        const at = nextTime + Math.max(0, cueTime(cue) - scheduledDuration)
        const onCue = () => {
          cueTimers.delete(timer)
          if (!settled && (settings?.features?.motionArbitration !== true || (motionAudioOwner === id && ownsMotionAudio(id, generationId)))) {
            if (cue.emotion) setEmotion(cue.emotion, cue.intensity)
            if (cue.motion) avatar?.playMotion(cue.motion, { source:'speech', generationId })
          }
        }
        const timer = settings?.features?.motionArbitration === true
          ? scheduleAtAudioOutput(ctx, at, onCue)
          : setTimeout(onCue, Math.max(0, (at - ctx.currentTime) * 1000))
        cueTimers.add(timer)
      }
      source.start(nextTime)
      nextTime += audio.duration
      scheduledDuration += audio.duration
    }
    function flushPending() {
      if (!bufferedSamples) return
      const combined = new Float32Array(bufferedSamples)
      let offset = 0
      for (const samples of pending) { combined.set(samples, offset); offset += samples.length }
      pending = []
      bufferedSamples = 0
      schedule(combined)
    }
    function startBuffered() {
      if (running) return
      running = true
      if (!startedPlayback) {
        startedPlayback = true
        const openingTimer = openingFillerTimers.get(generationId)
        if (openingTimer) clearTimeout(openingTimer)
        openingFillerTimers.delete(generationId)
        cancelGapFillerTimer(generationId)
        playbackNotBefore = finishFillerForAnswer(generationId)
        playedSpeechGenerations.add(generationId)
        window.__fastVoiceMetrics.firstPlaybackSeconds = (performance.now() - requestStartedAt) / 1000
        if (window.__deepseekE2EProbe && generationId && turnStarts.has(generationId)
            && !Number.isFinite(window.__deepseekE2EProbe.answerPlaybackElapsedMs)) {
          window.__deepseekE2EProbe.answerPlaybackElapsedMs = elapsedSince(turnStarts.get(generationId))
        }
        if (settings?.features?.motionArbitration !== true) {
          if (emotion) setEmotion(emotion, intensity)
          setAvatarState('speaking')
          avatar?.setSpeaking?.(true)
          if (motion) avatar?.playMotion(motion, { source:'speech', generationId })
        }
      reportAudioPresence(true)
        incrementE2EProbe('playbackStarts')
        onPlaybackStarted?.()
      }
      $('voiceProgress').textContent = 'お気に入りの声で読み上げ中'
      updateMouth()
      if (!mouthTimer) mouthTimer = setInterval(updateMouth, 50)
      flushPending()
    }
    function onEvent(event) {
      if (event.id !== id || settled) return
      if (generationId && generationId !== activeGenerationId) {
        incrementE2EProbe('staleVoiceEvents')
        const error = new Error('読み上げが中断されました')
        error.name = 'AbortError'
        return fail(error)
      }
      if (generationId && event.generationId !== generationId) return
      if (event.type === 'error') {
        const error = new Error(event.message || '音声生成に失敗しました')
        if (event.aborted) error.name = 'AbortError'
        return fail(error)
      }
      if (event.type === 'done') {
        ended = true
        streamDoneAt = performance.now()
        activeTtsStreams.delete(id)
        releaseTtsSlot?.()
        if (generationId && settings.features?.lowLatencySpeech === true) {
          setTimeout(() => maybeStartPrefetch(generationId), 75)
        }
        if (carry !== null) return fail(new Error('音声データが途中で切れました'))
        if (!received) return fail(new Error('音声データを受け取れませんでした'))
        if (!running) startBuffered()
        else flushPending()
        return maybeDone()
      }
      if (event.type !== 'audio') return
      const chunkAt = performance.now()
      if (lastAudioChunkAt !== null) chunkIntervalsMs.push(chunkAt - lastAudioChunkAt)
      lastAudioChunkAt = chunkAt
      const input = new Uint8Array(event.chunk)
      const bytes = new Uint8Array(input.length + (carry === null ? 0 : 1))
      let offset = 0
      if (carry !== null) { bytes[0] = carry; offset = 1; carry = null }
      bytes.set(input, offset)
      const even = bytes.length - bytes.length % 2
      if (even !== bytes.length) carry = bytes[even]
      if (!even) return
      if (!firstAudioLogged) {
        firstAudioLogged = true
        recordMetric('tts.first_audio', turnId, {
          elapsedMs: turnId && turnStarts.has(turnId) ? elapsedSince(turnStarts.get(turnId)) : elapsedSince(requestStartedAt),
          bytes: even,
        })
      }
      const values = new DataView(bytes.buffer, 0, even)
      const samples = new Float32Array(even / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = values.getInt16(i * 2, true) / 32768
        window.__fastVoiceMetrics.maxPcm = Math.max(window.__fastVoiceMetrics.maxPcm, Math.abs(samples[i]))
      }
      window.__fastVoiceMetrics.chunks++
      received = true
      if (running && nextTime && ctx.currentTime > nextTime + 0.025) {
        // A long sentence can still outpace generation; rebuild a lead once
        // rather than insert a small gap at every following audio chunk.
        running = false
        window.__fastVoiceMetrics.rebufferCount++
        const missedMs = (ctx.currentTime - nextTime) * 1000
        rebufferGapsMs.push(missedMs)
        recordMetric('audio.rebuffer', turnId, { gapMs:missedMs, audioSeconds:scheduledDuration })
        recoverySamples = 24000 * B.getRecoveryAudioBufferSeconds(initialBufferSeconds, window.__fastVoiceMetrics.rebufferCount)
      }
      pending.push(samples); bufferedSamples += samples.length
      if (running && bufferedSamples >= batchSamples) flushPending()
      else if (!running && !waitForComplete && bufferedSamples >= (startedPlayback ? recoverySamples : initialSamples)) startBuffered()
    }
    $('voiceProgress').textContent = waitForComplete ? '文の音声を整えています…' : 'お気に入りの声を準備中…'
    recordMetric('tts.request_start', turnId, {
      elapsedMs: turnId && turnStarts.has(turnId) ? elapsedSince(turnStarts.get(turnId)) : elapsedSince(requestStartedAt),
    })
    if (generationId && playedSpeechGenerations.has(generationId)) scheduleGapFiller(generationId)
    const start = async () => {
      try {
        releaseTtsSlot = await acquireTtsSlot(generationId)
        if (settled) { releaseTtsSlot(); return }
        markTtsStreamActive(id)
        api.startVoiceStream(id, text, generationId)
      } catch (error) { fail(error) }
    }
    start()
  })
}

function speakWithBrowserTTS(text) {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ja-JP'
      u.rate = settings.voice.speedScale || 1
      const fake = setInterval(() => avatar?.setMouth(0.25 + Math.random() * 0.5), 120)
      reportPresence({ speaking:true })
      u.onend = u.onerror = () => {
        clearInterval(fake)
        avatar?.setMouth(0)
        reportAudioPresence(false)
        resolve()
      }
      speechSynthesis.speak(u)
    } catch {
      resolve()
    }
  })
}

async function speakSentence(text, motion, emotion, intensity, cues, waitForComplete, turnId,
  generationId = activeGenerationId, onPlaybackStarted = null) {
  if (!settings.voice.enabled || !text) return
  try { await playFastVoice(text, motion, emotion, intensity, cues, waitForComplete, turnId,
    generationId, onPlaybackStarted) }
  catch (e) {
    if (generationId && generationId !== activeGenerationId) return
    $('voiceProgress').textContent = '音声エラー: ' + (e.message || e)
  }
}

function maybeStartPrefetch(generationId) {
  if (settings?.features?.lowLatencySpeech !== true || !generationId || generationId !== activeGenerationId
      || !speaking || prefetchTask || activeTtsStreams.size || !speakQueue.length) return
  const plan = speakQueue[0]
  if (plan.generationId !== generationId) return
  const task = { generationId, plan, promise: synthesizeFastPCM(plan.text, plan.turnId, generationId) }
  incrementE2EProbe('prefetchStarts')
  task.promise.catch(() => {})
  prefetchTask = task
}

function synthesizeFastPCM(text, turnId, generationId) {
  return new Promise((resolve, reject) => {
    if (generationId !== activeGenerationId) return reject(new Error('読み上げが中断されました'))
    const id = crypto.randomUUID()
    const chunks = []
    let sampleCount = 0
    let settled = false
    let firstAudio = false
    let carry = null
    let releaseTtsSlot = null
    const startedAt = performance.now()
    const off = api.onVoiceStream(event => {
      if (event.id !== id || settled) return
      if (event.generationId !== generationId || generationId !== activeGenerationId) {
        incrementE2EProbe('staleVoiceEvents')
        return fail(new Error('読み上げが中断されました'))
      }
      if (event.type === 'error') return fail(new Error(event.message || '音声生成に失敗しました'))
      if (event.type === 'audio') {
        const input = new Uint8Array(event.chunk)
        const bytes = new Uint8Array(input.length + (carry === null ? 0 : 1))
        let byteOffset = 0
        if (carry !== null) { bytes[0] = carry; byteOffset = 1; carry = null }
        bytes.set(input, byteOffset)
        const even = bytes.length - bytes.length % 2
        if (even !== bytes.length) carry = bytes[even]
        if (!even) return
        if (!firstAudio) {
          firstAudio = true
          recordMetric('tts.prefetch_first_audio', turnId, { elapsedMs: elapsedSince(startedAt), bytes: even })
        }
        const values = new DataView(bytes.buffer, bytes.byteOffset, even)
        const samples = new Float32Array(even / 2)
        for (let i = 0; i < samples.length; i++) samples[i] = values.getInt16(i * 2, true) / 32768
        chunks.push(samples)
        sampleCount += samples.length
      } else if (event.type === 'done') {
        if (!sampleCount || carry !== null) return fail(new Error('音声データを受け取れませんでした'))
        settled = true
        clearTimeout(timeout)
        off()
        activeTtsStreams.delete(id)
        releaseTtsSlot?.()
        const samples = new Float32Array(sampleCount)
        let offset = 0
        for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
        resolve(samples)
      }
    })
    const timeout = setTimeout(() => fail(new Error('音声生成に時間がかかりすぎました')), 300000)
    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      off()
      activeTtsStreams.delete(id)
      releaseTtsSlot?.()
      api.cancelVoiceStream(id)
      reject(error)
    }
    recordMetric('tts.prefetch_start', turnId, { elapsedMs: elapsedSince(startedAt) })
    const start = async () => {
      try {
        releaseTtsSlot = await acquireTtsSlot(generationId)
        if (settled) { releaseTtsSlot(); return }
        markTtsStreamActive(id)
        api.startVoiceStream(id, text, generationId)
      } catch (error) { fail(error) }
    }
    start()
  })
}

async function playPreparedPCM(samples, plan, generationId, onPlaybackStarted) {
  if (!settings.voice.enabled || !samples.length || generationId !== activeGenerationId) return
  const ctx = ensureAudio()
  if (ctx.state === 'suspended') await ctx.resume()
  if (generationId !== activeGenerationId) return
  const audio = ctx.createBuffer(1, samples.length, 24000)
  audio.copyToChannel(samples, 0)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.connect(ctx.destination)
  const levels = new Uint8Array(analyser.frequencyBinCount)
  const source = ctx.createBufferSource()
  source.buffer = audio
  source.connect(analyser)
  cancelGapFillerTimer(generationId)
  const openingTimer = openingFillerTimers.get(generationId)
  if (openingTimer) clearTimeout(openingTimer)
  openingFillerTimers.delete(generationId)
  const fillerEndAt = finishFillerForAnswer(generationId)
  playedSpeechGenerations.add(generationId)
  const sequenceId = generationId || plan.turnId
  const previousEnd = sequenceId ? lastSpeechEndByTurn.get(sequenceId) : null
  if (sequenceId && Number.isFinite(previousEnd)) recordMetric('audio.sentence_boundary', sequenceId, {
    gapMs:Math.max(0, (ctx.currentTime - previousEnd) * 1000), audioSeconds:0,
  })
  if (sequenceId) lastSpeechEndByTurn.delete(sequenceId)
  const first = plan.cues[0] || {}
  const guardedMotion = settings?.features?.motionArbitration === true
  let answerStartsAt = guardedMotion ? Math.max(ctx.currentTime + 0.02, fillerEndAt) : null
  let motionActivated = false
  const activateMotion = () => {
    if (motionActivated || !activeAudioSources.has(source) || generationId !== activeGenerationId
        || !hasAudioOutputReached(ctx, answerStartsAt) || !claimMotionAudio(source, generationId)) return
    motionActivated = true
    if (settings?.features?.motionArbitration === true) avatar?.cancelMotionSource?.('filler')
    if (first.emotion) setEmotion(first.emotion, first.intensity)
    setAvatarState('speaking')
    avatar?.setSpeaking?.(true)
    if (first.motion) avatar?.playMotion(first.motion, { source:'speech', generationId })
  }
  if (!guardedMotion) {
    if (first.emotion) setEmotion(first.emotion, first.intensity)
    setAvatarState('speaking')
    avatar?.setSpeaking?.(true)
    if (first.motion) avatar?.playMotion(first.motion, { source:'speech', generationId })
  }
  reportAudioPresence(true)
  const cueTimers = []
  const textLength = Math.max(1, [...plan.text].length)
  for (const cue of plan.cues.slice(1)) {
    const onCue = () => {
      if (guardedMotion && motionAudioOwner !== source) activateMotion()
      if (generationId !== activeGenerationId || (guardedMotion && (motionAudioOwner !== source || !ownsMotionAudio(source, generationId)))) return
      if (cue.emotion) setEmotion(cue.emotion, cue.intensity)
      if (cue.motion) avatar?.playMotion(cue.motion, { source:'speech', generationId })
    }
    const timer = guardedMotion
      ? scheduleAtAudioOutput(ctx, answerStartsAt + cue.offset / textLength * audio.duration, onCue)
      : setTimeout(onCue, Math.max(0, cue.offset / textLength * audio.duration * 1000 + (guardedMotion ? Math.max(0, (answerStartsAt - ctx.currentTime) * 1000) : 0)))
    cueTimers.push(timer)
  }
  let mouthTimer = null
  const updateMouth = () => {
    if (settings?.features?.motionArbitration === true && ctx.state !== 'running') {
      if (motionAudioOwner === source) { avatar?.setSpeaking?.(false); avatar?.setMouth(0) }
      return
    }
    if (settings?.features?.motionArbitration === true && !motionAudioOwner && answerStartsAt !== null
        && hasAudioOutputReached(ctx, answerStartsAt)) activateMotion()
    if (settings?.features?.motionArbitration === true && motionAudioOwner !== source) return
    if (settings?.features?.motionArbitration === true && motionAudioOwner === source) avatar?.setSpeaking?.(true)
    if (!ownsMotionAudio(source, generationId)) return
    analyser.getByteTimeDomainData(levels)
    let sum = 0
    for (const value of levels) { const sample = (value - 128) / 128; sum += sample * sample }
    avatar?.setMouth(Math.min(1, Math.sqrt(sum / levels.length) * 3.2))
  }
  updateMouth()
  mouthTimer = setInterval(updateMouth, 50)
  activeAudioSources.add(source)
  if (answerStartsAt === null) answerStartsAt = Math.max(ctx.currentTime + 0.02, fillerEndAt)
  const activationTimer = guardedMotion ? scheduleAtAudioOutput(ctx, answerStartsAt, activateMotion) : null
  recordFillerHandoff(generationId, answerStartsAt)
  recordMetric('audio.first_scheduled', plan.turnId, { elapsedMs: elapsedSince(turnStarts.get(plan.turnId) || performance.now()), scheduledLeadMs:Math.max(0, (answerStartsAt - ctx.currentTime) * 1000) })
  onPlaybackStarted?.()
  await new Promise(resolve => {
    if (guardedMotion) source.__deepseekResolvePlayback = resolve
    source.onended = resolve
    source.start(answerStartsAt)
  })
  if (guardedMotion) delete source.__deepseekResolvePlayback
  if (sequenceId) {
    lastSpeechEndByTurn.set(sequenceId, ctx.currentTime)
    while (lastSpeechEndByTurn.size > 40) lastSpeechEndByTurn.delete(lastSpeechEndByTurn.keys().next().value)
  }
  activeAudioSources.delete(source)
  if (activationTimer !== null) clearAudioTimer(activationTimer)
  clearInterval(mouthTimer)
  for (const timer of cueTimers) clearAudioTimer(timer)
  source.disconnect()
  analyser.disconnect()
  if (ownsMotionAudio(source, generationId)) {
    avatar?.setSpeaking?.(false)
    avatar?.setMouth(0)
    if (motionAudioOwner === source) motionAudioOwner = null
  }
  reportAudioPresence(false)
  if (generationId === activeGenerationId) setAvatarState('reacting')
}

function processSpeakQueue(generationId = activeGenerationId) {
  if (previewing) return Promise.resolve()
  if (speechWorkerPromise) return speechWorkerGeneration === generationId ? speechWorkerPromise : Promise.resolve()
  speechWorkerGeneration = generationId
  const worker = Promise.resolve().then(async () => {
    speaking = true
    reportPresence({ speaking:true })
    try {
      for (;;) {
        if (generationId && generationId !== activeGenerationId) break
        if (!speakQueue.length) {
          if (generationId && streamingSpeechGeneration === generationId) {
            await new Promise(resolve => { speechQueueWake = resolve })
            continue
          }
          break
        }
        const plan = speakQueue.shift()
        if (generationId && plan.generationId !== generationId) continue
        const first = plan.cues[0] || {}
        if (generationId) activeSpeechEmotion.set(generationId, first.emotion || 'neutral')
        const prefetched = prefetchTask?.generationId === generationId && prefetchTask.plan === plan
          ? prefetchTask : null
        if (prefetched) {
          prefetchTask = null
          if (playedSpeechGenerations.has(generationId)) scheduleGapFiller(generationId)
          try {
            const samples = await prefetched.promise
            cancelGapFillerTimer(generationId)
            if (generationId && generationId !== activeGenerationId) break
            await playPreparedPCM(samples, plan, generationId, () => maybeStartPrefetch(generationId))
            continue
          } catch (error) {
            cancelGapFillerTimer(generationId)
            if (generationId && generationId !== activeGenerationId) break
          }
        }
        const bufferSentenceForSmoothness = settings.features?.lowLatencySpeech === true
          && [...plan.text].length <= 40
        await speakSentence(plan.text, first.motion, first.emotion, first.intensity,
          plan.cues, bufferSentenceForSmoothness, plan.turnId, generationId,
          () => maybeStartPrefetch(generationId))
      }
    } finally {
      if (speechWorkerGeneration === generationId) {
        const openingTimer = openingFillerTimers.get(generationId)
        if (openingTimer) clearTimeout(openingTimer)
        openingFillerTimers.delete(generationId)
        cancelGapFillerTimer(generationId)
        if (activeFillerPlayback?.generationId === generationId) stopActiveAudio()
        lastSpeechEndByTurn.delete(generationId)
        fillerHandoffs.delete(generationId)
        activeSpeechEmotion.delete(generationId)
        playedSpeechGenerations.delete(generationId)
        for (const key of fillerAudioStarted) if (key.startsWith(`${generationId}:`)) fillerAudioStarted.delete(key)
        if (generationId) incrementE2EProbe('workerFinishes')
        speaking = false
        reportPresence({ speaking:false })
        if (generationId === activeGenerationId || generationId === null) {
          if (settings?.features?.motionArbitration === true && generationId) avatar?.cancelMotionSource?.('speech', generationId)
          streamingSpeechGeneration = null
          finishEmotionAfterSpeech()
          setAvatarState('idle')
          if (generationId) activeGenerationId = null
          if (generationId) activeAutonomySpeech = false
        if (generationId && generationId === activeProactiveSpeechGenerationId) {
          activeProactiveSpeechGenerationId = null
          activeFollowUpMemoryId = null
          api.finishProactiveSpeech(generationId).catch(() => {})
        }
          checkVoicevox().catch(() => {})
        }
        speechWorkerPromise = null
        speechWorkerGeneration = null
        wakeSpeechQueue()
      }
    }
  })
  speechWorkerPromise = worker
  return worker
}

function speakSegments(segments, turnId = null) {
  const plans = P.buildSpeechPlan(segments)
  if (turnId) {
    for (const plan of plans) plan.turnId = turnId
    const startedAt = turnStarts.get(turnId)
    recordMetric('speech.plan_ready', turnId, {
      elapsedMs: startedAt === undefined ? 0 : elapsedSince(startedAt),
      planCount: plans.length,
      textChars: plans.reduce((sum, plan) => sum + [...plan.text].length, 0),
    })
  }
  addSpeechPlans(plans, settings?.features?.motionArbitration === true ? turnId : null)
}

/* ---------------- チャット ---------------- */

function addMessage(role, content, ts) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.textContent = content
  if (ts) {
    const t = document.createElement('span')
    t.className = 'ts'
    t.textContent = new Date(ts).toLocaleString('ja-JP')
    div.appendChild(t)
  }
  $('chatLog').appendChild(div)
  $('chatLog').scrollTop = $('chatLog').scrollHeight
  return div
}

function addSystemMessage(text) {
  return addMessage('system', text)
}

function clearFollowUpCard() {
  if (followUpDismissTimer) clearTimeout(followUpDismissTimer)
  followUpDismissTimer = null
  $('followUpCard').hidden = true
  activeFollowUpMemoryId = null
}

async function resolveFollowUp(action, nextAt = null) {
  const memoryId = activeFollowUpMemoryId
  if (!memoryId) return false
  const result = await api.respondToFollowUp(memoryId, action, nextAt)
  if (!result?.ok) {
    $('followUpText').textContent = result?.error || '状態を更新できませんでした'
    return false
  }
  clearFollowUpCard()
  await refreshMemoryList()
  return true
}

function presentFollowUp({ memoryId, text } = {}) {
  if (!memoryId || !text || chatSending || speaking || listening || settings?.autonomy?.focusMode) return false
  clearSilentReaction()
  clearFollowUpCard()
  activeFollowUpMemoryId = String(memoryId)
  $('followUpText').textContent = String(text).slice(0, 220)
  $('followUpCard').hidden = false
  followUpDismissTimer = setTimeout(() => { resolveFollowUp('dismiss').catch(() => clearFollowUpCard()) }, 90 * 1000)
  return true
}

function clearCalendarPresenceCard() {
  if (calendarPresenceDismissTimer) clearTimeout(calendarPresenceDismissTimer)
  calendarPresenceDismissTimer=null
  $('calendarPresenceCard').hidden=true
  activeCalendarPresence=null
}

function presentCalendarPresence(payload={}) {
  if (!payload.key || !payload.text || chatSending || speaking || listening || settings?.autonomy?.focusMode) return false
  if (activeFollowUpMemoryId) clearFollowUpCard()
  clearSilentReaction()
  activeCalendarPresence={ key:String(payload.key),kind:String(payload.kind||''),eventId:payload.eventId||null,text:String(payload.text) }
  $('calendarPresenceHeading').textContent=payload.kind==='briefing'?'今日の予定':payload.kind==='study'?'勉強の提案':'カレンダーのお知らせ'
  $('calendarPresenceText').textContent=activeCalendarPresence.text
  for (const button of $('calendarPresenceCard').querySelectorAll('[data-calendar-presence-action]')) {
    const action=button.dataset.calendarPresenceAction
    button.hidden=payload.kind==='briefing' || (action==='start' && payload.kind!=='study') || (action==='completed' && !['deadline','exam-followup'].includes(payload.kind))
      || (action==='mute' && !payload.eventId)
  }
  $('calendarPresenceCard').hidden=false
  if (calendarPresenceDismissTimer) clearTimeout(calendarPresenceDismissTimer)
  calendarPresenceDismissTimer=setTimeout(()=>respondToCalendarPresence('dismiss').catch(()=>clearCalendarPresenceCard()),90_000)
  return true
}

async function respondToCalendarPresence(action) {
  const item=activeCalendarPresence
  if (!item) return false
  const result=await api.respondToCalendarPresence({key:item.key,eventId:item.eventId,kind:item.kind,action})
  if (!result?.ok) { $('calendarPresenceText').textContent=result?.error||'状態を更新できませんでした'; return false }
  clearCalendarPresenceCard()
  if (action==='start') { $('chatInput').value='さっきの勉強提案を始めよう'; $('chatInput').focus() }
  if (action==='completed') refreshCalendar().catch(()=>{})
  refreshCalendarPresenceHistory().catch(()=>{})
  return true
}

async function editFollowUpMemory() {
  const memoryId = activeFollowUpMemoryId
  if (!memoryId) return
  await resolveFollowUp('dismiss')
  $('btnSettings').click()
  await refreshMemoryList()
  const row = $('memoryList').querySelector(`[data-memory-id="${CSS.escape(memoryId)}"]`)
  row?.querySelector('textarea')?.focus()
}

async function postponeFollowUp() {
  const raw = $('followUpRemindAt').value
  const nextAt = raw ? new Date(raw).getTime() : null
  if (raw && (!Number.isFinite(nextAt) || nextAt <= Date.now())) {
    $('followUpText').textContent = '未来の日時を選んでください。空欄なら1週間後に確認します。'
    return
  }
  await resolveFollowUp('later', nextAt)
}

function stripTagsForDisplay(raw) {
  return P.cleanText(raw)
    .replace(/\[[^\]]*$/, '')
}

async function sendChat(text) {
  const value = String(text || '').trim()
  if (!value) return
  if (activeFollowUpMemoryId) resolveFollowUp('dismiss').catch(() => clearFollowUpCard())
  if (activeCalendarPresence) respondToCalendarPresence('dismiss').catch(() => clearCalendarPresenceCard())
  cancelThinkingFillerPreparation()
  const lowLatency = settings.features?.lowLatencySpeech === true
  const adaptiveEnabled = settings.features?.adaptiveVoiceResponse === true && !window.AdaptiveVoice.wantsFullReading(value)
  const canInterrupt = lowLatency || adaptiveEnabled || settings.features?.instantReaction === true || settings.features?.motionArbitration === true
  if (chatSending && !canInterrupt) return
  const motionTurn = settings.features?.motionArbitration === true ? crypto.randomUUID() : null
  if (motionTurn) { pendingMotionTurn = motionTurn; avatar?.beginMotionTurn?.(motionTurn) }
  if (settings.features?.silentReactions === true) {
    clearSilentReaction()
    const now = performance.now()
    if (!settings.autonomy?.focusMode && !speaking && !chatSending && !activeFillerPlayback && !activeAutonomySpeech && avatar?.kind === 'live2d' && !avatar.motion && !avatar.nod && now - lastSilentNodAt >= 10000) {
      avatar.playMotion('nod', { source:'reaction', generationId:motionTurn })
      silentNod = avatar.nod
      if (silentNod) silentNod.strength = 0.4
      lastSilentNodAt = now
    }
  }
  const instantToken = settings.features?.instantReaction === true ? instantReaction.begin() : null
  const pendingInterrupt = activeInterruptPromise
  if (pendingInterrupt) { try { await pendingInterrupt } catch {} }
  if (activeAutonomySpeech || (canInterrupt && (activeGenerationId || chatSending || speaking))) await interruptActiveTurn({ preservePending:true })
  else if (chatSending) return
  if (instantToken !== null) {
    if (!instantReaction.current(instantToken)) return
    if (instantReaction.phase === 'idle') instantReaction.begin()
  }
  if (motionTurn && pendingMotionTurn !== motionTurn) return
  if (pendingMotionTurn === motionTurn) pendingMotionTurn = null
  const generationId = motionTurn || crypto.randomUUID()
  activeGenerationId = generationId
  streamingSpeechGeneration = (lowLatency || adaptiveEnabled) && settings.voice.enabled ? generationId : null
  streamingSpeechChunker = streamingSpeechGeneration
    ? (adaptiveEnabled ? new window.AdaptiveVoice.Selector({ cautious:window.AdaptiveVoice.needsCaution(value) }) : new StreamingSpeech.StreamingSpeechChunker()) : null
  const turnId = generationId
  const turnStartedAt = performance.now()
  turnStarts.set(turnId, turnStartedAt)
  while (turnStarts.size > 100) turnStarts.delete(turnStarts.keys().next().value)
  recordMetric('user.input', turnId, { inputChars: [...value].length })
  chatSending = true
  $('btnSend').disabled = !canInterrupt
  addMessage('user', value)
  $('chatInput').value = ''
  const bubble = addMessage('assistant', '…')
  let raw = ''
  let firstToken = true
  const off = api.onChatToken((packet) => {
    if ((adaptiveEnabled || settings.features?.motionArbitration === true) && generationId !== activeGenerationId) return
    const event = typeof packet === 'string' ? { generationId, delta: packet } : packet
    if (event.generationId && event.generationId !== generationId) return
    if (firstToken) {
      firstToken = false
      recordMetric('llm.first_token', turnId, { elapsedMs: elapsedSince(turnStartedAt) })
    }
    raw += event.delta || ''
    bubble.textContent = stripTagsForDisplay(raw) || '…'
    $('chatLog').scrollTop = $('chatLog').scrollHeight
    if (streamingSpeechChunker) addSpeechPlans(streamingSpeechChunker.push(event.delta), generationId)
  })
  setStatus('考え中…')
  setAvatarState('thinking')
  setEmotion('thinking', 0.65)
  try {
    const chatRequest = api.sendChat(value, generationId)
    scheduleOpeningFiller(generationId)
    const result = await chatRequest
    off()
    if (result?.interrupted || generationId !== activeGenerationId) return
    incrementE2EProbe('chatResponsesCompleted')
    recordMetric('llm.completed', turnId, { elapsedMs: elapsedSince(turnStartedAt) })
    bubble.textContent = result.plainText
    setStatus('待機中')
    if (!(settings.features?.instantReaction === true && speaking)) setAvatarState('reacting')
    if (streamingSpeechChunker) {
      addSpeechPlans(streamingSpeechChunker.finish(), generationId)
      streamingSpeechChunker = null
      streamingSpeechGeneration = null
      wakeSpeechQueue()
      processSpeakQueue(generationId).catch(e => console.error(e))
    } else {
      speakSegments(result.segments, turnId)
      streamingSpeechGeneration = null
      if (lowLatency || adaptiveEnabled) {
        chatSending = false
        $('btnSend').disabled = false
        activeGenerationId = null
      }
    }
  } catch (e) {
    off()
    if (generationId !== activeGenerationId) return
    if (adaptiveEnabled) {
      await interruptActiveTurn()
      if (activeGenerationId !== null) return
      chatSending = false
      $('btnSend').disabled = false
    }
    streamingSpeechGeneration = null
    streamingSpeechChunker = null
    wakeSpeechQueue()
    recordMetric('turn.failed', turnId, { elapsedMs: elapsedSince(turnStartedAt) })
    const rawMsg = String(e.message || e)
      .replace(/Error invoking remote method '[^']+':\s*/g, '')
      .replace(/^(DeepSeekError|QwenTtsError|VoicevoxError):\s*/g, '')
    bubble.textContent = `（エラー）${rawMsg}`
    setStatus('エラーが発生しました')
    setEmotion('neutral')
    setAvatarState('idle')
    if (rawMsg.includes('401')) {
      addSystemMessage('APIキーが認証されませんでした。⚙設定の「DeepSeek APIキー」に、疎通テストで成功したほうのキーを貼り直して保存してください（仮キーでは認証できません）。')
    }
    if (String(e.message).includes('DEEPSEEK_API_KEY')) {
      addSystemMessage('DeepSeek APIキーが未設定です。⚙設定からキーを入力してください。キーは https://platform.deepseek.com で取得できます。')
    }
  } finally {
    if (generationId === activeGenerationId) {
      chatSending = false
      $('btnSend').disabled = false
    }
  }
}

/* ---------------- 音声入力 ---------------- */

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    $('btnMic').disabled = true
    $('btnMic').title = 'この環境では音声認識が使えません'
    return
  }
  recog = new SR()
  recog.lang = settings.speechInput.lang || 'ja-JP'
  recog.interimResults = true
  recog.continuous = Boolean(settings.speechInput.continuous)
  recog.onresult = (ev) => {
    let interim = ''
    let finalText = ''
    for (const r of ev.results) {
      if (r.isFinal) finalText += r[0].transcript
      else interim += r[0].transcript
    }
    $('chatInput').value = finalText || interim
    if (finalText && $('chkAutoSend').checked) {
      stopListening()
      sendChat(finalText)
    }
  }
  recog.onend = () => {
    listening = false
    reportPresence({ listening:false })
    $('btnMic').classList.remove('listening')
    if (!chatSending) setAvatarState('idle')
  }
  recog.onerror = (ev) => {
    listening = false
    reportPresence({ listening:false })
    $('btnMic').classList.remove('listening')
    setAvatarState('idle')
    if (ev.error === 'not-allowed') addSystemMessage('マイクの使用が許可されていません。Windowsの設定でマイク許可を確認してください。')
  }
}

function startListening() {
  ensureAudio()
  if (!recog) setupRecognition()
  if (!recog) return
  try {
    recog.lang = settings.speechInput.lang || 'ja-JP'
    recog.start()
    listening = true
    reportPresence({ listening:true })
    setAvatarState('listening')
    $('btnMic').classList.add('listening')
  } catch {
    /* 既に開始している場合など */
  }
}

function stopListening() {
  try {
    recog?.stop()
  } catch {}
  listening = false
  reportPresence({ listening:false })
  $('btnMic').classList.remove('listening')
  if (!chatSending) setAvatarState('idle')
}

/* ---------------- VOICEVOX 状態 ---------------- */

async function checkVoicevox() {
  let status = 'offline'
  try {
    const st = await api.voiceStatus()
    voicevoxAvailable = st.available
    status = st.status || (st.available ? 'ready' : 'offline')
  } catch {
    voicevoxAvailable = false
  }
  if (voicevoxAvailable && !thinkingFillerCache) refreshThinkingFillerCache().catch(() => {})
  updateVoiceDot()
  if (!speaking && !previewing) {
    $('voiceProgress').textContent = voicevoxAvailable ? '音声エンジン接続済み・声を試聴できます' :
      status === 'error' ? 'Qwenの起動に失敗しました。アプリを終了して再起動してください。' :
      status === 'loading' ? 'Qwenの音声モデルを読み込み中です…' :
      status === 'missing-key' ? 'クラウド用APIキーを設定してください。' :
      'Qwenに未接続です。アプリを再起動しても解消しない場合はログをご確認ください。'
  }
  console.log('[tts] engine check:', settings?.voice?.engine, 'available:', voicevoxAvailable)
  return voicevoxAvailable
}

function updateVoiceDot() {
  $('voiceDot').className = 'dot ' + (voicevoxAvailable ? 'ok' : 'ng')
  $('voiceDot').title = voicevoxAvailable ? 'TTS 接続OK' : (settings?.voice?.engine === 'qwen3' ? 'Qwen 未接続' : 'TTS 未接続（ブラウザTTSで代替）')
}

async function loadSpeakers(selected) {
  const sel = $('setSpeaker')
  sel.innerHTML = ''
  if (voicevoxAvailable) {
    try {
      const list = await api.voiceSpeakers()
      for (const s of list) {
        const o = document.createElement('option')
        o.value = s.styleId ?? s.id
        o.textContent = s.label
        sel.appendChild(o)
      }
    } catch (e) {
      console.warn(e)
    }
  }
  if (!sel.options.length) {
    const o = document.createElement('option')
    o.value = selected
    o.textContent = `話者ID: ${selected}（VOICEVOX未接続のため一覧取得不可）`
    sel.appendChild(o)
  }
  sel.value = String(selected)
}

/* ---------------- 設定パネル ---------------- */

function fillSettings() {
  const s = settings
  $('setModel').value = s.ai.model
  $('setThinkingMode').value = s.ai.thinkingMode || 'disabled'
  $('setCharName').value = s.character.name
  $('setPersonality').value = s.character.personality
  $('setSpeakingStyle').value = s.character.speakingStyle
  $('setExtraPrompt').value = s.character.extraPrompt || ''
  $('setEngine').value = s.voice.engine || 'voicevox'
  $('setVoiceEnabled').checked = s.voice.enabled
  $('setVoiceUrl').value = s.voice.serverUrl
  $('setSpeed').value = s.voice.speedScale
  $('setPitch').value = s.voice.pitchScale
  $('setAvatarMode').value = s.avatar.mode
  $('setMouthX').value = s.avatar.mouthX ?? 0.5
  $('setMouthY').value = s.avatar.mouthY ?? 0.66
  $('setQwenMode').value = s.qwen.mode
  $('setQwenServerUrl').value = s.qwen.serverUrl
  $('setQwenModel').value = s.qwen.model
  $('setQwenSpeaker').value = s.qwen.speaker
  $('setQwenLanguage').value = s.qwen.language
  $('setQwenInstruct').value = s.qwen.instruct || ''
  $('setQwenSpeed').value = s.qwen.speed ?? 1
  $('setQwenPitch').value = s.qwen.pitch ?? 0
  $('setMotionAmount').value = s.avatar.motionAmount ?? 0.7
  $('setNaturalIdle').checked = s.features?.live2dNaturalIdle === true
  $('setInstantReaction').checked = s.features?.instantReaction === true
  $('setAdaptiveVoice').checked = s.features?.adaptiveVoiceResponse === true
  $('setSilentReactions').checked = s.features?.silentReactions === true
  $('setMotionArbitration').checked = s.features?.motionArbitration === true
  $('setEmotionPersistence').checked = s.features?.emotionPersistence === true
  $('setLowLatencySpeech').checked = s.features?.lowLatencySpeech === true
  const fillers = TF.normalizeThinkingFillers(s.thinkingFillers)
  $('setThinkingFillersEnabled').checked = fillers.enabled
  $('setThinkingFillersMode').value = fillers.mode
  $('setThinkingFillerStartDelay').value = String(fillers.startDelayMs)
  $('setThinkingFillersFrequency').value = String(fillers.frequency)
  for (const input of document.querySelectorAll('[data-filler-id]')) input.checked = fillers.phrases.includes(input.dataset.fillerId)
  $('setSpeechEnabled').checked = s.speechInput.enabled
  $('setIdleEnabled').checked = s.idleTalk.enabled
  $('setIdleMinutes').value = Math.max(5, s.idleTalk.intervalMinutes || 15)
  $('setAutonomyActionsEnabled').checked = s.autonomy?.actionsEnabled === true
  $('setAutonomyActionMinutes').value = s.autonomy?.actionIntervalMinutes || 5
  $('setAutonomyFocusMode').checked = s.autonomy?.focusMode === true
  $('setDesktopContextEnabled').checked = s.desktopContext?.enabled === true
  $('setFollowUpsEnabled').checked = s.proactive?.followUpsEnabled === true
  $('setFollowUpDelivery').value = s.proactive?.delivery === 'voice' ? 'voice' : 'bubble'
  $('setFollowUpQuietEnabled').checked = s.proactive?.quietHours?.enabled !== false
  $('setFollowUpQuietStart').value = s.proactive?.quietHours?.start || '22:00'
  $('setFollowUpQuietEnd').value = s.proactive?.quietHours?.end || '08:00'
  $('setFollowUpDailyMax').value = String(s.proactive?.dailyMax === 1 ? 1 : 2)
  const cp=s.calendarPresence || {}
  $('setCalendarBriefingEnabled').checked=cp.briefingEnabled===true
  $('setCalendarBriefingTime').value=cp.briefingTime||'08:00'
  $('setCalendarClassQuietEnabled').checked=cp.classQuietEnabled===true
  $('setCalendarClassQuietLead').value=String(cp.classQuietLeadMinutes??15)
  $('setCalendarDeadlinesEnabled').checked=cp.deadlineRemindersEnabled===true
  $('setCalendarExamsEnabled').checked=cp.examRemindersEnabled===true
  $('setCalendarEventsEnabled').checked=cp.eventRemindersEnabled===true
  $('setCalendarReminderLead').value=String(cp.reminderLeadMinutes??1440)
  $('setCalendarFollowUpsEnabled').checked=cp.automaticFollowUpsEnabled===true
  $('setCalendarStudyEnabled').checked=cp.studyRivalEnabled===true
  $('setCalendarVoiceEnabled').checked=cp.voiceEnabled===true
  $('setCalendarCloudVoiceEnabled').checked=cp.allowCloudVoice===true
  $('setCalendarQuietEnabled').checked=cp.quietHours?.enabled!==false
  $('setCalendarQuietStart').value=cp.quietHours?.start||'22:00'
  $('setCalendarQuietEnd').value=cp.quietHours?.end||'08:00'
  $('setLongTermMemoryEnabled').checked = s.memory?.longTermEnabled === true
  $('setMemorySendContextToDeepSeek').checked = s.memory?.sendContextToDeepSeek === true
  $('setMemorySendContextToDeepSeek').disabled = s.memory?.longTermEnabled !== true
  refreshMemoryList().catch(() => {})
  loadSpeakers(s.voice.speaker)
}

const MEMORY_TYPE_LABELS = { user_fact:'ユーザーの事実', preference:'好み', open_loop:'未完了の話題', commitment:'予定・約束' }
const MEMORY_STATUS_LABELS = { active:'有効', planned:'予定', completed:'完了', postponed:'延期', cancelled:'取消', expired:'期限切れ', superseded:'更新済み' }

async function refreshMemoryList() {
  const list = $('memoryList')
  if (!list) return
  list.replaceChildren()
  try {
    const result = await api.listMemories()
    const status = result?.status || {}
    $('memoryStoragePath').textContent = status.storagePath || '取得できません'
    if (!status.writable) $('memoryStatus').textContent = status.loadError
      ? `記憶ファイルを保護中です: ${status.loadError}` : '記憶ファイルへ保存できません。既存データは変更されていません。'
    else $('memoryStatus').textContent = `${result.items?.length || 0} 件を保存中${status.loadError ? `（${status.loadError}）` : ''}`
    const followUpState = await api.proactiveState().catch(() => ({ mutedMemoryIds:[] }))
    const mutedMemoryIds = new Set(followUpState?.mutedMemoryIds || [])
    for (const item of result.items || []) {
      const row = document.createElement('div')
      row.className = 'memory-row'
      row.dataset.memoryId = item.id
      const metadata = document.createElement('div')
      metadata.className = 'memory-meta'
      metadata.textContent = `${MEMORY_TYPE_LABELS[item.type] || '記憶'} ・ ${MEMORY_STATUS_LABELS[item.status] || item.status}`
        + `${item.followUpAt ? ` ・ 確認予定: ${new Date(item.followUpAt).toLocaleString()}` : ''}`
        + `${item.sensitive ? ' ・ API送信対象外' : ''}`
      const type = document.createElement('select')
      for (const [value, label] of Object.entries(MEMORY_TYPE_LABELS)) {
        const option = document.createElement('option'); option.value = value; option.textContent = label; type.append(option)
      }
      type.value = item.type
      const content = document.createElement('textarea')
      content.rows = 2; content.maxLength = 500; content.value = item.content; content.setAttribute('aria-label', '記憶内容')
      const state = document.createElement('select')
      for (const [value, label] of Object.entries(MEMORY_STATUS_LABELS)) {
        const option = document.createElement('option'); option.value = value; option.textContent = label; state.append(option)
      }
      state.value = item.status
      const actions = document.createElement('div'); actions.className = 'memory-actions'
      const save = document.createElement('button'); save.type = 'button'; save.textContent = '変更を保存'
      save.addEventListener('click', async () => {
        const updated = await api.updateMemory(item.id, { type:type.value, content:content.value, status:state.value })
        $('memoryStatus').textContent = updated?.ok ? '記憶を更新しました' : (updated?.error || '更新できませんでした')
        await refreshMemoryList()
      })
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '削除'
      remove.addEventListener('click', async () => {
        if (!await api.deleteMemory(item.id)) { $('memoryStatus').textContent = '削除できませんでした'; return }
        await refreshMemoryList()
      })
      actions.append(save)
      if (['open_loop','commitment'].includes(item.type) && ['active','planned','postponed'].includes(item.status)) {
        const mute = document.createElement('button'); mute.type = 'button'
        mute.textContent = mutedMemoryIds.has(item.id) ? '通知を再開' : '通知を停止'
        mute.addEventListener('click', async () => {
          const response = await api.setFollowUpMuted(item.id, !mutedMemoryIds.has(item.id))
          $('memoryStatus').textContent = response?.ok ? (response.muted ? 'この話題の通知を停止しました' : 'この話題の通知を再開しました') : (response?.error || '通知設定を更新できませんでした')
          await refreshMemoryList()
        })
        actions.append(mute)
      }
      actions.append(remove); row.append(metadata, type, content, state, actions); list.append(row)
    }
  } catch (error) {
    $('memoryStatus').textContent = `記憶一覧を読み込めません: ${String(error?.message || error).slice(0, 160)}`
  }
}

async function scanMemoryHistory() {
  const host = $('memoryCandidates')
  host.replaceChildren()
  const result = await api.scanMemoryHistory()
  if (result?.error) { $('memoryStatus').textContent = result.error; return }
  if (!result.candidates?.length) { $('memoryStatus').textContent = '保存候補は見つかりませんでした'; return }
  $('memoryStatus').textContent = `${result.candidates.length} 件の候補を端末内で確認しました。内容を見て必要なものだけ保存してください。`
  for (const rowData of result.candidates) {
    const row = document.createElement('div'); row.className = 'memory-row'
    const metadata = document.createElement('div'); metadata.className = 'memory-meta'
    metadata.textContent = `${MEMORY_TYPE_LABELS[rowData.candidate.type] || '記憶候補'} ・ 過去のユーザー発言${rowData.sourceDate ? ` ・ ${new Date(rowData.sourceDate).toLocaleDateString()}` : ''}`
    const content = document.createElement('div'); content.textContent = rowData.candidate.content
    const actions = document.createElement('div'); actions.className = 'memory-actions'
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'この候補を保存'
    save.addEventListener('click', async () => {
      const saved = await api.importMemoryHistoryCandidate(rowData.sourceMessageId, rowData.candidateIndex)
      $('memoryStatus').textContent = saved?.ok ? (saved.item?.duplicate ? '同じ記憶が登録済みです' : '過去の発言から記憶を保存しました') : (saved?.error || '保存できませんでした')
      row.remove()
      await refreshMemoryList()
    })
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '今回は保存しない'
    dismiss.addEventListener('click', () => row.remove())
    actions.append(save, dismiss); row.append(metadata, content, actions); host.append(row)
  }
}

function collectSettings() {
  const s = structuredClone(settings)
  s.ai.model = $('setModel').value
  s.ai.thinkingMode = $('setThinkingMode').value
  s.character.name = $('setCharName').value.trim() || s.character.name
  s.character.personality = $('setPersonality').value
  s.character.speakingStyle = $('setSpeakingStyle').value
  s.character.extraPrompt = $('setExtraPrompt').value
  s.avatar.mode = $('setAvatarMode').value
  s.avatar.mouthX = Number($('setMouthX').value)
  s.avatar.mouthY = Number($('setMouthY').value)
  s.avatar.motionAmount = Math.max(0, Math.min(1.5, Number($('setMotionAmount').value) || 0))
  s.features = { ...(s.features || {}), live2dNaturalIdle: $('setNaturalIdle').checked,
    instantReaction: $('setInstantReaction').checked,
    adaptiveVoiceResponse: $('setAdaptiveVoice').checked,
    silentReactions: $('setSilentReactions').checked,
    motionArbitration: $('setMotionArbitration').checked,
    emotionPersistence: $('setEmotionPersistence').checked,
    lowLatencySpeech: $('setLowLatencySpeech').checked }
  s.thinkingFillers = TF.normalizeThinkingFillers({
    enabled:$('setThinkingFillersEnabled').checked,
    mode:$('setThinkingFillersMode').value,
    startDelayMs:Number($('setThinkingFillerStartDelay').value),
    frequency:Number($('setThinkingFillersFrequency').value),
    phrases:[...document.querySelectorAll('[data-filler-id]:checked')].map(input => input.dataset.fillerId),
  })
  s.speechInput.enabled = $('setSpeechEnabled').checked
  s.idleTalk.enabled = $('setIdleEnabled').checked
  s.idleTalk.intervalMinutes = Math.max(5, Math.min(240, Number($('setIdleMinutes').value) || 15))
  s.autonomy = { ...(s.autonomy || {}),
    actionsEnabled: $('setAutonomyActionsEnabled').checked,
    actionIntervalMinutes: Math.max(1, Math.min(60, Number($('setAutonomyActionMinutes').value) || 5)),
    focusMode: $('setAutonomyFocusMode').checked }
  s.desktopContext = { ...(s.desktopContext || {}), enabled:$('setDesktopContextEnabled').checked }
  const longTermEnabled = $('setLongTermMemoryEnabled').checked
  s.memory = { ...(s.memory || {}), longTermEnabled,
    sendContextToDeepSeek:longTermEnabled && $('setMemorySendContextToDeepSeek').checked }
  s.proactive = { ...(s.proactive || {}),
    followUpsEnabled:$('setFollowUpsEnabled').checked,
    delivery:$('setFollowUpDelivery').value === 'voice' ? 'voice' : 'bubble',
    quietHours:{ ...(s.proactive?.quietHours || {}), enabled:$('setFollowUpQuietEnabled').checked,
      start:$('setFollowUpQuietStart').value || '22:00', end:$('setFollowUpQuietEnd').value || '08:00' },
    dailyMax:Number($('setFollowUpDailyMax').value) === 1 ? 1 : 2 }
  s.calendarPresence={ ...(s.calendarPresence||{}),
    briefingEnabled:$('setCalendarBriefingEnabled').checked,
    briefingTime:$('setCalendarBriefingTime').value||'08:00',
    classQuietEnabled:$('setCalendarClassQuietEnabled').checked,
    classQuietLeadMinutes:Math.max(0,Math.min(180,Number($('setCalendarClassQuietLead').value)||0)),
    deadlineRemindersEnabled:$('setCalendarDeadlinesEnabled').checked,
    examRemindersEnabled:$('setCalendarExamsEnabled').checked,
    eventRemindersEnabled:$('setCalendarEventsEnabled').checked,
    reminderLeadMinutes:Math.max(5,Math.min(10080,Number($('setCalendarReminderLead').value)||1440)),
    automaticFollowUpsEnabled:$('setCalendarFollowUpsEnabled').checked,
    studyRivalEnabled:$('setCalendarStudyEnabled').checked,
    voiceEnabled:$('setCalendarVoiceEnabled').checked,
    allowCloudVoice:$('setCalendarCloudVoiceEnabled').checked,
    quietHours:{ ...(s.calendarPresence?.quietHours||{}),enabled:$('setCalendarQuietEnabled').checked,
      start:$('setCalendarQuietStart').value||'22:00',end:$('setCalendarQuietEnd').value||'08:00' } }
  return s
}

/* ---------------- 初期化 ---------------- */

function setStatus(t) {
  $('statusText').textContent = t
}

async function init() {
  const cfg = await api.getConfig()
  settings = cfg.settings
  refreshThinkingFillerCache().catch(() => {})
  $('quickVoice').value = 'voice-a'
  settings.voice.enabled = true
  $('charName').textContent = settings.character.name
  if (!cfg.hasApiKey) {
    addSystemMessage('ようこそ！ まず ⚙設定から DeepSeek APIキーを入力してください。（キーは https://platform.deepseek.com で取得できます）')
  }
  if (cfg.plugins?.length) {
    $('pluginList').textContent = '読み込み済みプラグイン: ' + cfg.plugins.map((p) => `${p.name}（${p.id}）`).join('、')
  }

  const hist = await api.listHistory()
  for (const item of hist.slice(-100)) addMessage(item.role, item.content, item.ts)
  if (hist.length) addSystemMessage(`過去の会話 ${hist.length} 件を読み込みました`)

  await initAvatar()
  if (new URLSearchParams(window.location.search).get('deepseek-e2e') === '1') {
    const probe = { voiceRequests:0, playbackStarts:0, prefetchStarts:0, queuedPlans:0, chatResponsesCompleted:0,
      interrupts:0, staleVoiceEvents:0, workerFinishes:0, autonomyActions:0,
      fillerStarts:0, fillerWhileTtsAndLlm:0, fillerTransitions:0,
      fillerGapStarts:0, fillerOpeningStarts:0, fillerGapTransitions:0, fillerOpeningTransitions:0,
      fillerTtsActiveAtStart:0, fillerChatSendingAtStart:false, fillerStartElapsedMs:[], fillerHandoffGapsMs:[], answerPlaybackElapsedMs:null,
      maxActiveTtsStreams:0 }
    Object.defineProperty(window, '__deepseekE2EProbe', {
      configurable: false, enumerable: false, value: probe,
    })
    Object.defineProperty(window, '__deepseekE2E', {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        getAvatar: () => avatar,
        sendChat: text => sendChat(text),
        interrupt: () => interruptActiveTurn(),
        seedThinkingFillerCache: () => {
          const samples = new Float32Array(96000)
          for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 2 * Math.PI * 220 / 24000) * 0.12
          thinkingFillerCache = { voiceFingerprint:'e2e', sampleRate:24000,
            clips:{ hmm:{ pcmBase64:encodeFillerSamples(samples), sampleCount:samples.length },
              eto:{ pcmBase64:encodeFillerSamples(samples), sampleCount:samples.length } } }
        },
        startTestFiller: (generationId, position = 'opening') => {
          localStorage.removeItem('deepseek-chan-filler-history-v1')
          activeGenerationId = generationId
          if (settings.features?.motionArbitration === true && !avatar?.motionArbiter?.isCurrent(generationId)) avatar?.beginMotionTurn?.(generationId)
          turnStarts.set(generationId, performance.now())
          return startCachedFiller(generationId, position)
        },
        playTestGapAnswer: async generationId => {
          activeGenerationId = generationId
          if (settings.features?.motionArbitration === true) avatar?.beginMotionTurn?.(generationId)
          turnStarts.set(generationId, performance.now())
          localStorage.removeItem('deepseek-chan-filler-history-v1')
          settings.thinkingFillers = { enabled:true, mode:'opening-gap', startDelayMs:550, frequency:0.85, phrases:['hmm'] }
          window.__deepseekE2E.seedThinkingFillerCache()
          playedSpeechGenerations.add(generationId)
          const started = startCachedFiller(generationId, 'gap')
          await waitMs(80)
          const activeBeforeAnswer = Boolean(activeFillerPlayback)
          const samples = new Float32Array(12000)
          await playPreparedPCM(samples, { text:'テスト回答。', turnId:generationId, cues:[] }, generationId)
          const ended = !activeFillerPlayback
          await interruptActiveTurn()
          return { started, activeBeforeAnswer, ended,
            gapStartCount:probe.fillerGapStarts, gapTransitionCount:probe.fillerGapTransitions }
        },
        playTestQuickCue: async generationId => {
          activeGenerationId = generationId
          if (settings.features?.motionArbitration === true) avatar?.beginMotionTurn?.(generationId)
          let cueMotionTriggered = false
          const originalPlayMotion = avatar?.playMotion
          if (avatar) avatar.playMotion = function (name, options) {
            if (name === 'nod' && options?.generationId === generationId) cueMotionTriggered = true
            return originalPlayMotion.call(this, name, options)
          }
          const samples = new Float32Array(12000)
          samples.fill(0.04)
          try {
            await playPreparedPCM(samples, { text:'あ'.repeat(100), turnId:generationId,
              cues:[{ offset:0, emotion:'neutral' }, { offset:1, emotion:'happy', motion:'nod' }] }, generationId)
          } finally {
            delete avatar.playMotion
          }
          const emotionApplied = avatar?.emotion === 'happy'
          const motionApplied = cueMotionTriggered
          await interruptActiveTurn()
          avatar?.setEmotion?.('neutral')
          return { emotionApplied, motionApplied }
        },
        interruptTestPCM: async generationId => {
          activeGenerationId = generationId
          if (settings.features?.motionArbitration === true) avatar?.beginMotionTurn?.(generationId)
          const samples = new Float32Array(24000 * 2)
          samples.fill(0.04)
          const playback = playPreparedPCM(samples, { text:'テスト音声。', turnId:generationId, cues:[] }, generationId)
          const deadline = Date.now() + 1000
          while (!avatar?.speaking && Date.now() < deadline) await waitMs(20)
          const playbackStarted = avatar?.speaking === true
          await interruptActiveTurn()
          await playback
          return { playbackStarted, interrupted:activeGenerationId === null,
            mouthClosed:avatar?.mouth === 0, speakingStopped:avatar?.speaking === false }
        },
        getPipeline: () => ({ ...probe, fillerStartElapsedMs:[...probe.fillerStartElapsedMs],
          fillerHandoffGapsMs:[...probe.fillerHandoffGapsMs], speaking, chatSending, autonomySpeech:activeAutonomySpeech,
          interrupting:Boolean(activeInterruptPromise), queued: speakQueue.length, generationId: activeGenerationId,
          fillerActive:Boolean(activeFillerPlayback), activeTtsStreams:activeTtsStreams.size }),
        autonomyAction: action => handleAutonomyAction({ action }),
      }),
    })
  }
  startRenderPerformanceSampler()
  await checkVoicevox()
  if (!voicevoxAvailable) {
    addSystemMessage('お気に入りの声を準備しています。接続済みになったら「声を試聴」で確認できます。')
  }
  setupRecognition()
  setStatus('待機中')
  setInterval(checkVoicevox, 5000)

  api.onPluginSay(payload => handlePluginSay(payload))
  api.onFollowUp(payload => presentFollowUp(payload))
  api.onCalendarPresenceNotice(payload => presentCalendarPresence(payload))
  api.onCalendarPresenceClear(payload => {
    if (!payload?.key || activeCalendarPresence?.key===payload.key) clearCalendarPresenceCard()
  })
  api.onProactiveCancel(generationId => {
    if (!generationId) return
    cancelledProactiveSpeechIds.add(String(generationId))
    if (cancelledProactiveSpeechIds.size > 50) cancelledProactiveSpeechIds.delete(cancelledProactiveSpeechIds.values().next().value)
    if (activeGenerationId === generationId) interruptActiveTurn().catch(() => {})
  })
  api.onAutonomyAction(payload => handleAutonomyAction(payload))
  api.onAutonomyInterrupt(() => {
    if (activeAutonomySpeech) interruptActiveTurn().catch(() => {})
  })
}

function handlePluginSay({ text, segments, generationId, autonomy, proactive, calendarPresence } = {}) {
  if (!text || !String(text).trim()) return
  if (proactive === true) {
    const id = typeof generationId === 'string' && generationId ? generationId : ''
    const calendarVoiceAllowed=calendarPresence===true && settings.calendarPresence?.voiceEnabled===true
      && (settings.qwen?.mode!=='cloud' || settings.calendarPresence?.allowCloudVoice===true)
    const followUpVoiceAllowed=calendarPresence!==true && settings.proactive?.followUpsEnabled
      && settings.proactive?.delivery==='voice'
    if (!id || cancelledProactiveSpeechIds.has(id) || (!calendarVoiceAllowed && !followUpVoiceAllowed)
        || !settings.voice?.enabled || settings.autonomy?.focusMode
        || chatSending || speaking || listening || activeGenerationId) {
      if (id) { cancelledProactiveSpeechIds.delete(id); api.finishProactiveSpeech(id).catch(() => {}) }
      return
    }
    activeGenerationId = id
    activeProactiveSpeechGenerationId = id
    if (settings.features?.motionArbitration === true) avatar?.beginMotionTurn?.(id)
    activeAutonomySpeech = true
    const plans = P.buildSpeechPlan(segments?.length ? segments : [{ emotion:'neutral', motion:'think', text }])
    if (!plans.length) {
      activeGenerationId = null; activeAutonomySpeech = false; activeProactiveSpeechGenerationId = null
      api.finishProactiveSpeech(id).catch(() => {})
      return
    }
    setAvatarState('reacting')
    addSpeechPlans(plans, id)
    return
  }
  if (autonomy === true) {
    if (!settings.idleTalk?.enabled || !settings.voice?.enabled || settings.autonomy?.focusMode
        || chatSending || speaking || listening || activeGenerationId) return
    const id = typeof generationId === 'string' && generationId ? generationId : crypto.randomUUID()
    activeGenerationId = id
    if (settings.features?.motionArbitration === true) avatar?.beginMotionTurn?.(id)
    activeAutonomySpeech = true
    const plans = P.buildSpeechPlan(segments?.length ? segments : [{ emotion:'neutral', motion:null, text }])
    if (!plans.length) { activeGenerationId = null; activeAutonomySpeech = false; return }
    addMessage('assistant', text)
    setAvatarState('reacting')
    addSpeechPlans(plans, id)
    return
  }
  addMessage('assistant', text)
  setAvatarState('reacting')
  speakSegments(segments && segments.length ? segments : [{ emotion: 'neutral', motion: null, text }])
}

function handleAutonomyAction({ action } = {}) {
  if (!settings?.autonomy?.actionsEnabled || settings.autonomy.focusMode || chatSending
      || speaking || listening || previewing || activeAutonomySpeech || !avatar) return false
  if (!['nod', 'think', 'shy', 'cheer', 'bow'].includes(action)) return false
  avatar.playMotion(action, { source:'autonomy' })
  incrementE2EProbe('autonomyActions')
  return true
}

/* ---------------- イベント ---------------- */

for (const [buttonId, panelId] of [['btnVoiceTools', 'voiceStudio'], ['btnHistory', 'historyBar']]) {
  $(buttonId).addEventListener('click', () => {
    const panel = $(panelId)
    panel.hidden = !panel.hidden
    $(buttonId).setAttribute('aria-expanded', String(!panel.hidden))
  })
}

const CALENDAR_CATEGORY_LABELS = { lesson:'授業', exam:'試験', assignment:'課題', study:'勉強', personal:'個人', other:'その他' }
const CALENDAR_STATUS_LABELS = { not_started:'未着手', in_progress:'進行中', completed:'完了', cancelled:'取り消し' }

function calendarDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function calendarDateAdd(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day + days)
  return calendarDateKey(date)
}

function calendarInputDateTime(value, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

async function calendarDateTimeIso(value, timeZone) {
  if (!value) return null
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/u)
  if (!match) throw new Error('日時を確認してください')
  const result = await api.resolveCalendarLocalTime(match[1], match[2], timeZone)
  if (!result?.ok) throw new Error(result?.error || '日時を確認してください')
  return result.iso
}

function calendarSetStatus(text, error = false) {
  $('calendarStatus').textContent = text || ''
  $('calendarStatus').classList.toggle('error', error)
}

function calendarFormatDate(dateKey, options = { month:'long', day:'numeric', weekday:'short' }) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat('ja-JP', options).format(new Date(year, month - 1, day))
}

function calendarDisplayDate(event) {
  if (event.allDay) return event.occurrenceDate || event.startDate
  const value = event.startAt || event.deadlineAt
  return value ? calendarDateKey(new Date(value)) : event.occurrenceDate || event.startDate
}

function calendarEventTime(event) {
  if (event.allDay) return '終日'
  const value = event.startAt || event.deadlineAt
  if (!value) return '時刻未設定'
  const date = new Date(value)
  const time = new Intl.DateTimeFormat('ja-JP', { hour:'2-digit', minute:'2-digit' }).format(date)
  return event.deadlineAt && !event.startAt ? `締切 ${time}` : time
}

function renderCalendarEventRow(event) {
  const button = document.createElement('button')
  button.type = 'button'; button.className = 'calendar-event-row'
  if (event.completed || event.taskStatus === 'completed') button.classList.add('completed')
  if (event.taskStatus === 'cancelled') button.classList.add('cancelled')
  const dot = document.createElement('span'); dot.className = 'calendar-category-dot'; dot.dataset.category = event.category
  const time = document.createElement('span'); time.className = 'calendar-event-time'; time.textContent = calendarEventTime(event)
  const title = document.createElement('span'); title.className = 'calendar-event-title'
  title.textContent = `${CALENDAR_CATEGORY_LABELS[event.category] || '予定'} ・${event.title}${event.taskStatus && event.taskStatus !== 'not_applicable' ? ` ・${CALENDAR_STATUS_LABELS[event.taskStatus] || ''}` : ''}${event.recurring ? ' ↻' : ''}`
  button.append(dot, time, title)
  button.addEventListener('click', () => openCalendarEditor(event).catch(error => calendarSetStatus(error.message, true)))
  return button
}

function renderCalendarSummary(targetId, items, emptyText) {
  const target = $(targetId)
  target.replaceChildren()
  if (!items?.length) { target.textContent = emptyText; return }
  const visible = items.slice(0, 2).map(event => `${calendarEventTime(event)} ${event.title}`)
  target.textContent = `${visible.join(' ・ ')}${items.length > visible.length ? ` ほか${items.length - visible.length}件` : ''}`
}

async function refreshCalendar() {
  if (!calendarSelectedDate) calendarSelectedDate = calendarDateKey()
  if (!calendarMonthCursor) calendarMonthCursor = new Date(new Date(`${calendarSelectedDate}T12:00:00`))
  calendarMonthCursor = new Date(calendarMonthCursor.getFullYear(), calendarMonthCursor.getMonth(), 1)
  const year = calendarMonthCursor.getFullYear(); const month = calendarMonthCursor.getMonth() + 1
  const [monthResult, dayResult, summary, status] = await Promise.all([
    api.calendarMonth(year, month), api.calendarDate(calendarSelectedDate), api.calendarSummary(), api.calendarStatus(),
  ])
  if (monthResult?.error || dayResult?.error) { calendarSetStatus(monthResult?.error || dayResult?.error, true); return }
  calendarWritable = status?.writable !== false
  $('btnNewCalendarEvent').disabled = !calendarWritable
  $('btnCalendarExport').disabled = !calendarWritable
  $('btnCalendarImport').disabled = !calendarWritable
  calendarSetStatus(status?.writable === false ? `カレンダーを保護中: ${status.loadError || '保存できません'}` : `${status?.count || 0} 件の予定をこのPCに保存中`)
  $('btnCalendarRestoreBackup').hidden = status?.writable !== false
  $('calendarMonthTitle').textContent = new Intl.DateTimeFormat('ja-JP', { year:'numeric', month:'long' }).format(calendarMonthCursor)
  $('calendarSelectedDate').textContent = calendarFormatDate(calendarSelectedDate)
  renderCalendarSummary('calendarTodaySummary', summary.today, '予定なし')
  renderCalendarSummary('calendarTomorrowSummary', summary.tomorrow, '予定なし')
  renderCalendarSummary('calendarWeekSummary', summary.week, '予定なし')
  refreshCalendarPresenceHistory().catch(()=>{})

  const monthEvents = monthResult.items || []
  const byDate = new Map()
  for (const event of monthEvents) {
    const key = calendarDisplayDate(event)
    if (!key) continue
    byDate.set(key, (byDate.get(key) || 0) + 1)
  }
  const firstDay = new Date(year, month - 1, 1)
  const gridStart = new Date(year, month - 1, 1 - firstDay.getDay())
  const grid = $('calendarGrid'); grid.replaceChildren()
  const today = calendarDateKey()
  for (let index = 0; index < 42; index++) {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
    const key = calendarDateKey(date)
    const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-day'; button.setAttribute('role', 'gridcell')
    if (date.getMonth() !== month - 1) button.classList.add('outside')
    if (key === today) button.classList.add('today')
    if (key === calendarSelectedDate) button.classList.add('selected')
    const number = document.createElement('span'); number.textContent = String(date.getDate())
    const count = document.createElement('span'); count.className = 'calendar-day-count'; count.textContent = byDate.get(key) ? `${byDate.get(key)}件` : '\u00a0'
    button.append(number, count)
    button.addEventListener('click', () => {
      calendarSelectedDate = key
      calendarMonthCursor = new Date(date.getFullYear(), date.getMonth(), 1)
      closeCalendarEditor(); refreshCalendar().catch(error => calendarSetStatus(error.message, true))
    })
    grid.append(button)
  }
  const agenda = $('calendarAgenda'); agenda.replaceChildren()
  for (const event of dayResult.items || []) agenda.append(renderCalendarEventRow(event))
  if (!dayResult.items?.length) { const empty = document.createElement('div'); empty.className = 'hint'; empty.textContent = 'この日の予定はありません'; agenda.append(empty) }
}

async function refreshCalendarPresenceHistory() {
  const state=await api.calendarPresenceHistory()
  if (!$('calendarPresenceHistory')) return
  const times=(state.entries||[]).slice(-5).map(row=>new Date(row.at).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))
  $('calendarPresenceHistory').textContent=state.writable===false
    ? `通知履歴を保護中: ${state.error||'読み込みに失敗しました'}`
    : `${state.paused?'自動通知は一時停止中':'今日の自動通知'}：${state.countToday||0}件${times.length?` ・最近：${times.join('、')}`:''}`
  $('btnCalendarPresencePause').textContent=state.paused?'自動通知を再開':'自動通知を24時間停止'
  $('btnCalendarPresencePause').dataset.paused=String(state.paused===true)
}

async function showManualCalendarBriefing() {
  const briefing=await api.calendarPresenceBriefing()
  const target=$('calendarBriefing')
  target.textContent=briefing?.error?briefing.error:(briefing?.lines?.length?`${briefing.spoken}\n\n${briefing.lines.join('\n')}`:briefing?.spoken||'今日の予定を取得できませんでした')
  target.hidden=false
}

async function searchCalendar() {
  const query = $('calendarSearchQuery').value.trim()
  const results = $('calendarSearchResults')
  results.replaceChildren()
  if (!query) { results.hidden = true; return }
  const result = await api.searchCalendar(query, $('calendarSearchCategory').value)
  results.hidden = false
  if (result?.error) { calendarSetStatus(result.error, true); return }
  if (!result?.items?.length) { results.textContent = '該当する予定はありません'; return }
  const heading = document.createElement('strong'); heading.textContent = `検索結果 ${result.items.length} 件`
  results.append(heading)
  for (const event of result.items) results.append(renderCalendarEventRow(event))
}

function setCalendarRepeatVisible() {
  const enabled = $('calendarWeekly').checked
  $('calendarRepeatOptions').hidden = !enabled
  if (enabled && !$('calendarRepeatEnd').value) $('calendarRepeatEnd').value = calendarDateAdd($('calendarStartDate').value || calendarSelectedDate, 90)
  if (enabled && !$('calendarWeekdayPicks').querySelector('input:checked')) {
    const date = new Date(`${$('calendarStartDate').value || calendarSelectedDate}T12:00:00`)
    $('calendarRepeatOptions').querySelector(`input[value="${date.getDay()}"]`).checked = true
  }
}

async function populateCalendarMemoryLinks(selectedId = '') {
  const select = $('calendarLinkedMemory')
  select.replaceChildren()
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'リンクしない'; select.append(empty)
  try {
    const result = await api.listMemories()
    for (const memory of result?.items || []) {
      const option = document.createElement('option')
      option.value = memory.id
      option.textContent = `${memory.type || '記憶'} ・${memory.content || ''}`
      select.append(option)
    }
  } catch {}
  if (selectedId && ![...select.options].some(option => option.value === selectedId)) {
    const missing = document.createElement('option'); missing.value = selectedId; missing.textContent = '現在一覧にない記憶（関連付けを保持）'; select.append(missing)
  }
  select.value = selectedId || ''
}

function fillCalendarEditor(event, parent = null, scope = 'occurrence') {
  const source = parent?.recurrence && scope === 'series' ? parent : event
  calendarEditingTimeZone = source?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  $('calendarForm').hidden = false
  $('calendarFormTitle').textContent = event?.id ? '予定を編集' : '予定を登録'
  $('calendarEventTitle').value = source?.title || ''
  $('calendarCategory').value = source?.category || 'personal'
  $('calendarAllDay').checked = source?.allDay === true
  $('calendarHasStart').checked = Boolean(source?.startAt) || !source?.deadlineAt
  $('calendarStartDate').value = source?.startDate || (source?.startAt ? calendarInputDateTime(source.startAt, calendarEditingTimeZone).slice(0, 10) : calendarSelectedDate)
  $('calendarStartTime').value = source?.recurrence?.startTime || (source?.startAt ? calendarInputDateTime(source.startAt, calendarEditingTimeZone).slice(11) : '09:00')
  $('calendarEndDate').value = source?.endDate || (source?.endAt ? calendarInputDateTime(source.endAt, calendarEditingTimeZone).slice(0, 10) : source?.startDate || calendarSelectedDate)
  $('calendarEndTime').value = source?.recurrence?.endTime || (source?.endAt ? calendarInputDateTime(source.endAt, calendarEditingTimeZone).slice(11) : '')
  $('calendarDeadline').value = calendarInputDateTime(source?.deadlineAt, calendarEditingTimeZone)
  $('calendarMemo').value = source?.memo || ''
  $('calendarLinkedMemory').value = source?.linkedMemoryId || ''
  $('calendarNotify').checked = source?.notify === true
  $('calendarTaskStatus').value = source?.taskStatus && source.taskStatus !== 'not_applicable' ? source.taskStatus : 'not_started'
  $('calendarTaskStatusWrap').hidden = !['assignment','study'].includes($('calendarCategory').value)
  $('calendarWeekly').checked = Boolean(parent?.recurrence && scope === 'series')
  $('calendarRepeatEnd').value = source?.recurrence?.endDate || calendarDateAdd($('calendarStartDate').value || calendarSelectedDate, 90)
  $('calendarOvernight').checked = source?.recurrence?.endDayOffset === 1
  $('calendarRepeatOptions').querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = Boolean(source?.recurrence?.weekdays?.includes(Number(input.value))) })
  $('calendarEditScopeWrap').hidden = !parent?.recurrence
  $('calendarEditScope').value = scope
  $('btnDeleteCalendarEvent').hidden = !event?.id
  $('calendarWeekly').disabled = Boolean(parent?.recurrence && scope === 'occurrence')
  $('calendarAllDay').disabled = Boolean(parent?.recurrence)
  $('calendarStartTimeWrap').hidden = $('calendarAllDay').checked
  $('calendarEndTimeWrap').hidden = $('calendarAllDay').checked
  $('calendarStartDate').disabled = !$('calendarHasStart').checked && !$('calendarAllDay').checked
  $('calendarStartTime').disabled = !$('calendarHasStart').checked || $('calendarAllDay').checked
  if (!calendarWritable) for (const control of $('calendarForm').elements) control.disabled = true
  setCalendarRepeatVisible()
  $('calendarForm').scrollIntoView({ block:'nearest', behavior:'smooth' })
}

async function openCalendarEditor(event = null) {
  if (!event) {
    calendarEditingOccurrence = null; calendarEditingParent = null
    fillCalendarEditor(null)
    await populateCalendarMemoryLinks()
    $('calendarWeekly').disabled = false; $('calendarAllDay').disabled = false
    return
  }
  calendarEditingOccurrence = event
  calendarEditingParent = event.parentId ? await api.getCalendarEvent(event.parentId) : await api.getCalendarEvent(event.id)
  fillCalendarEditor(event, calendarEditingParent, event.parentId ? 'occurrence' : 'series')
  await populateCalendarMemoryLinks(event.linkedMemoryId || calendarEditingParent?.linkedMemoryId || '')
}

function closeCalendarEditor() {
  $('calendarForm').hidden = true
  calendarEditingOccurrence = null; calendarEditingParent = null
  $('calendarForm').reset()
  $('calendarWeekly').disabled = false; $('calendarAllDay').disabled = false
}

async function calendarFormPayload(includeRecurrence = false) {
  const allDay = $('calendarAllDay').checked
  const hasStart = $('calendarHasStart').checked
  const startDate = $('calendarStartDate').value || calendarSelectedDate
  const endDate = $('calendarEndDate').value || startDate
  const timeZone = calendarEditingTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  let startAt = null; let endAt = null
  if (hasStart && !allDay) {
    const startTime = $('calendarStartTime').value || '09:00'
    startAt = await calendarDateTimeIso(`${startDate}T${startTime}`, timeZone)
    const endTime = $('calendarEndTime').value
    if (endTime) endAt = await calendarDateTimeIso(`${endDate}T${endTime}`, timeZone)
  }
  const payload = { title:$('calendarEventTitle').value, category:$('calendarCategory').value,
    startAt, endAt, deadlineAt:allDay ? null : await calendarDateTimeIso($('calendarDeadline').value, timeZone),
    allDay, startDate, endDate, timeZone, memo:$('calendarMemo').value,
    notify:$('calendarNotify').checked,
    linkedMemoryId:$('calendarLinkedMemory').value || null,
    taskStatus:['assignment','study'].includes($('calendarCategory').value) ? $('calendarTaskStatus').value : 'not_applicable' }
  if (includeRecurrence && $('calendarWeekly').checked) {
    const weekdays = [...$('calendarRepeatOptions').querySelectorAll('input[type="checkbox"]:checked')].map(input => Number(input.value))
    if (!hasStart || allDay) throw new Error('毎週の授業には開始時刻を設定してください')
    payload.recurrence = { frequency:'weekly', weekdays, startDate, endDate:$('calendarRepeatEnd').value,
      startTime:$('calendarStartTime').value, endTime:$('calendarEndTime').value,
      endDayOffset:$('calendarOvernight').checked ? 1 : 0 }
  }
  return payload
}

async function saveCalendarForm(event) {
  event.preventDefault()
  try {
    const scope = $('calendarEditScope').value
    const payload = await calendarFormPayload(!calendarEditingParent?.recurrence || scope === 'series')
    let result
    if (!calendarEditingOccurrence) result = await api.addCalendarEvent(payload)
    else if (calendarEditingParent?.recurrence && scope === 'occurrence') result = await api.updateCalendarOccurrence(calendarEditingOccurrence.occurrenceId, payload)
    else result = await api.updateCalendarEvent(calendarEditingParent.id, payload)
    if (!result?.ok) throw new Error(result?.error || '予定を保存できませんでした')
    closeCalendarEditor()
    calendarSetStatus(result.duplicate ? '同じ予定がすでに登録されています' : '予定を保存しました')
    await refreshCalendar()
  } catch (error) { calendarSetStatus(String(error?.message || error), true) }
}

async function deleteCalendarSelection() {
  const scope = $('calendarEditScope').value
  if (!calendarEditingOccurrence || !window.confirm(scope === 'series' && calendarEditingParent?.recurrence
    ? 'この繰り返し予定をすべて削除しますか？個別の会話履歴や記憶は削除しません。'
    : 'この予定だけを削除しますか？')) return
  const result = calendarEditingParent?.recurrence && scope === 'occurrence'
    ? await api.deleteCalendarOccurrence(calendarEditingOccurrence.occurrenceId)
    : await api.deleteCalendarEvent(calendarEditingParent?.id || calendarEditingOccurrence.id)
  if (!result?.ok) { calendarSetStatus(result?.error || '予定を削除できませんでした', true); return }
  closeCalendarEditor(); calendarSetStatus('予定を削除しました'); await refreshCalendar()
}

async function persistCalendarShare(enabled) {
  if (enabled && !window.confirm('Phase 8Bで会話に予定を利用する場合、その内容がDeepSeek APIへ送信される可能性があります。Phase 8Aでは送信しません。この別個の共有許可を保存しますか？')) {
    $('calendarShareWithAssistant').checked = false; return
  }
  const next = structuredClone(settings)
  next.calendar = { ...(next.calendar || {}), shareWithAssistant:enabled }
  try {
    settings = (await api.saveConfig(next)).settings
    $('calendarShareWithAssistant').checked = settings.calendar?.shareWithAssistant === true
    calendarSetStatus(enabled ? '会話共有の許可を保存しました。Phase 8Aでは予定を送信しません。' : '会話共有をOFFにしました')
  } catch (error) {
    $('calendarShareWithAssistant').checked = settings.calendar?.shareWithAssistant === true
    calendarSetStatus(error.message || '設定を保存できませんでした', true)
  }
}

async function openCalendar() {
  if (!calendarSelectedDate) calendarSelectedDate = calendarDateKey()
  if (!calendarMonthCursor) calendarMonthCursor = new Date(new Date(`${calendarSelectedDate}T12:00:00`))
  $('calendarShareWithAssistant').checked = settings?.calendar?.shareWithAssistant === true
  $('historyBar').hidden = true; $('btnHistory').setAttribute('aria-expanded', 'false')
  $('voiceStudio').hidden = true; $('btnVoiceTools').setAttribute('aria-expanded', 'false')
  $('calendarPanel').classList.remove('hidden'); $('btnCalendar').setAttribute('aria-expanded', 'true')
  await refreshCalendar()
}

$('silentReactionBubble').addEventListener('animationend', () => {
  const bubble = $('silentReactionBubble')
  bubble.classList.remove('visible')
  bubble.hidden = true
})
$('btnDismissFollowUp').addEventListener('click', () => resolveFollowUp('dismiss').catch(() => clearFollowUpCard()))
$('btnLaterFollowUp').addEventListener('click', () => postponeFollowUp().catch(() => {}))
$('followUpCard').querySelectorAll('[data-follow-up-action]').forEach(button => button.addEventListener('click', () => {
  const action = button.dataset.followUpAction
  if (action === 'edit') { editFollowUpMemory().catch(() => clearFollowUpCard()); return }
  resolveFollowUp(action).catch(() => {})
}))
$('btnDismissCalendarPresence').addEventListener('click', () => respondToCalendarPresence('dismiss').catch(()=>clearCalendarPresenceCard()))
$('calendarPresenceCard').querySelectorAll('[data-calendar-presence-action]').forEach(button => button.addEventListener('click', () => {
  respondToCalendarPresence(button.dataset.calendarPresenceAction).catch(()=>{})
}))
$('btnCalendarBriefing').addEventListener('click', () => showManualCalendarBriefing().catch(error=>calendarSetStatus(error.message,true)))
$('btnCalendarPresencePause').addEventListener('click', async () => {
  const paused=$('btnCalendarPresencePause').dataset.paused==='true'
  const result=paused?await api.resumeCalendarPresence():await api.pauseCalendarPresence()
  if (!result?.ok) calendarSetStatus(result?.error||'設定を更新できませんでした',true)
  await refreshCalendarPresenceHistory()
})
$('btnCalendar').addEventListener('click', () => {
  if ($('calendarPanel').classList.contains('hidden')) openCalendar().catch(error => calendarSetStatus(error.message, true))
  else { $('calendarPanel').classList.add('hidden'); $('btnCalendar').setAttribute('aria-expanded', 'false') }
})
$('btnCloseCalendar').addEventListener('click', () => {
  $('calendarPanel').classList.add('hidden'); $('btnCalendar').setAttribute('aria-expanded', 'false')
})
$('btnCalendarPrev').addEventListener('click', () => {
  calendarMonthCursor = new Date(calendarMonthCursor.getFullYear(), calendarMonthCursor.getMonth() - 1, 1)
  refreshCalendar().catch(error => calendarSetStatus(error.message, true))
})
$('btnCalendarNext').addEventListener('click', () => {
  calendarMonthCursor = new Date(calendarMonthCursor.getFullYear(), calendarMonthCursor.getMonth() + 1, 1)
  refreshCalendar().catch(error => calendarSetStatus(error.message, true))
})
$('btnCalendarToday').addEventListener('click', () => {
  calendarSelectedDate = calendarDateKey(); calendarMonthCursor = new Date()
  closeCalendarEditor(); refreshCalendar().catch(error => calendarSetStatus(error.message, true))
})
$('btnCalendarSearch').addEventListener('click', () => searchCalendar().catch(error => calendarSetStatus(error.message, true)))
$('calendarSearchQuery').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); searchCalendar().catch(error => calendarSetStatus(error.message, true)) }
})
$('calendarSearchCategory').addEventListener('change', () => {
  if ($('calendarSearchQuery').value.trim()) searchCalendar().catch(error => calendarSetStatus(error.message, true))
})
$('btnNewCalendarEvent').addEventListener('click', () => openCalendarEditor().catch(error => calendarSetStatus(error.message, true)))
$('btnCancelCalendarEdit').addEventListener('click', closeCalendarEditor)
$('calendarForm').addEventListener('submit', saveCalendarForm)
$('btnDeleteCalendarEvent').addEventListener('click', () => deleteCalendarSelection().catch(error => calendarSetStatus(error.message, true)))
$('calendarCategory').addEventListener('change', () => { $('calendarTaskStatusWrap').hidden = !['assignment','study'].includes($('calendarCategory').value) })
$('calendarWeekly').addEventListener('change', setCalendarRepeatVisible)
$('calendarStartDate').addEventListener('change', () => {
  if (!$('calendarEndDate').value || $('calendarEndDate').value < $('calendarStartDate').value) $('calendarEndDate').value = $('calendarStartDate').value
  if ($('calendarWeekly').checked) setCalendarRepeatVisible()
})
$('calendarEditScope').addEventListener('change', () => {
  if (calendarEditingOccurrence) fillCalendarEditor(calendarEditingOccurrence, calendarEditingParent, $('calendarEditScope').value)
})
$('calendarAllDay').addEventListener('change', () => {
  const allDay = $('calendarAllDay').checked
  $('calendarStartTimeWrap').hidden = allDay; $('calendarEndTimeWrap').hidden = allDay
  if (allDay && $('calendarWeekly').checked) { $('calendarWeekly').checked = false; setCalendarRepeatVisible() }
})
$('calendarHasStart').addEventListener('change', () => {
  const enabled = $('calendarHasStart').checked
  $('calendarStartDate').disabled = !enabled && !$('calendarAllDay').checked
  $('calendarStartTime').disabled = !enabled || $('calendarAllDay').checked
  if (!enabled && $('calendarWeekly').checked) { $('calendarWeekly').checked = false; setCalendarRepeatVisible() }
})
$('calendarShareWithAssistant').addEventListener('change', event => persistCalendarShare(event.target.checked))
$('btnCalendarExport').addEventListener('click', async () => {
  const result = await api.exportCalendar()
  if (result?.ok) calendarSetStatus('カレンダーをJSONバックアップに保存しました')
  else if (!result?.canceled) calendarSetStatus(result?.error || 'バックアップを保存できませんでした', true)
})
$('btnCalendarImport').addEventListener('click', async () => {
  if (!window.confirm('JSONバックアップの予定をこのPCのカレンダーへ追加します。同じIDまたは同じ予定は重複登録しません。続けますか？')) return
  const result = await api.importCalendar()
  if (result?.ok) { calendarSetStatus(`${result.added} 件を追加、${result.duplicates} 件の重複を除外しました`); await refreshCalendar() }
  else if (!result?.canceled) calendarSetStatus(result?.error || 'バックアップを読み込めませんでした', true)
})
$('btnCalendarRestoreBackup').addEventListener('click', async () => {
  if (!window.confirm('壊れたカレンダーを別名で保管し、最後に保存したバックアップから復元します。続けますか？')) return
  const result = await api.restoreCalendarBackup()
  if (result?.ok) { calendarSetStatus(`${result.restored} 件をバックアップから復元しました`); await refreshCalendar() }
  else calendarSetStatus(result?.error || 'バックアップを復元できませんでした', true)
})
$('faceSelect').addEventListener('change', applySelectedEmotion)
$('btnSend').addEventListener('click', () => { ensureAudio(); sendChat($('chatInput').value) })
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { ensureAudio(); sendChat($('chatInput').value) }
})
  $('chatInput').addEventListener('input', () => {
    api.notifyActivity()
    if (activeAutonomySpeech && $('chatInput').value.trim()) interruptActiveTurn().catch(() => {})
  })
document.addEventListener('pointerdown', () => api.notifyActivity(), { capture:true, passive:true })
$('btnMic').addEventListener('click', () => (listening ? stopListening() : startListening()))
$('btnSettings').addEventListener('click', () => {
  fillSettings()
  $('settingsPanel').classList.remove('hidden')
})
$('btnCloseSettings').addEventListener('click', () => $('settingsPanel').classList.add('hidden'))
$('btnReloadSpeakers').addEventListener('click', async () => {
  await checkVoicevox()
  loadSpeakers(settings.voice.speaker)
})
$('btnPrepareThinkingFillers').addEventListener('click', () => prepareThinkingFillerCache())
$('btnSaveSettings').addEventListener('click', async () => {
  const nextSettings = collectSettings()
  const followUpsWereEnabled = settings.proactive?.followUpsEnabled === true
  const followUpsWillBeEnabled = nextSettings.proactive.followUpsEnabled === true
  const enablingVoiceFollowUps = followUpsWillBeEnabled && nextSettings.proactive.delivery === 'voice'
    && (!followUpsWereEnabled || settings.proactive?.delivery !== 'voice')
  if (!followUpsWereEnabled && followUpsWillBeEnabled && !window.confirm(
    '保存済みの予定・未完了の話題を使い、適切な時期に一度ずつ確認します。\n\n' +
    '吹き出しは初期方式です。新しいAPI呼び出しや追加料金は発生しません。\n' +
    '音声を選ぶ場合は既存のQwen音声と発話制限を使います。フォローアップを有効にしますか？'
  )) return
  if (enablingVoiceFollowUps && !window.confirm(
    'フォローアップを音声とLive2Dで再生します。設定中のQwen音声合成へ話題文を渡します。Qwenがクラウド設定の場合は話題文が外部送信され、Qwen側の料金がかかることがあります。追加のDeepSeek API呼び出しは行いません。音声での声かけを許可しますか？'
  )) return
  const enablingCalendarVoice=nextSettings.calendarPresence?.voiceEnabled===true && settings.calendarPresence?.voiceEnabled!==true
  const enablingCloudCalendarVoice=nextSettings.calendarPresence?.allowCloudVoice===true && settings.calendarPresence?.allowCloudVoice!==true
  if (enablingCalendarVoice && !window.confirm(
    'カレンダー通知を音声とLive2Dで再生します。通知文にはカレンダーの予定名が含まれることがあります。音声通知を許可しますか？'
  )) return
  if (enablingCloudCalendarVoice && !window.confirm(
    'クラウド音声設定では、カレンダー予定を含む短い通知文が音声サービスへ送信される可能性があります。予定通知のクラウド音声送信を許可しますか？'
  )) return
  const enablingMemory = settings.memory?.longTermEnabled !== true && nextSettings.memory.longTermEnabled === true
  const enablingSend = settings.memory?.sendContextToDeepSeek !== true && nextSettings.memory.sendContextToDeepSeek === true
  if ((enablingMemory || enablingSend) && !window.confirm(
    `長期記憶の設定を確認してください。\n\n` +
    `・記憶はこのPC内の保存先（${$('memoryStoragePath').textContent}）に保存します。\n` +
    `・${enablingMemory ? 'あなたの発言から明示された情報を端末内のルールで抽出します。\n' : ''}` +
    `・記憶をDeepSeek APIへ送る設定: ${nextSettings.memory.sendContextToDeepSeek ? 'ON（関連する最大3件）' : 'OFF'}\n` +
    `・外部LLMによる記憶抽出は行いません。よろしいですか？`
  )) return
  const key = $('setApiKey').value.trim()
  if (key) {
    await api.setApiKey(key)
    $('setApiKey').value = ''
    $('setApiKey').placeholder = '設定済み（変更する場合のみ入力）'
  }
  const dsKey = $('setDashscopeKey').value.trim()
  if (dsKey) {
    await api.setDashscopeKey(dsKey)
    $('setDashscopeKey').value = ''
    $('setDashscopeKey').placeholder = '設定済み（変更する場合のみ入力）'
  }
  const prevMode = settings.avatar.mode
  const wasInstantReaction = settings.features?.instantReaction === true
  const wasMotionArbitration = settings.features?.motionArbitration === true
  const result = await api.saveConfig(nextSettings)
  settings = result.settings
  if (!settings.proactive?.followUpsEnabled) clearFollowUpCard()
  avatar?.setMotionArbitrationEnabled?.(settings.features?.motionArbitration === true)
  if (!wasMotionArbitration && settings.features?.motionArbitration === true && activeGenerationId) avatar?.beginMotionTurn?.(activeGenerationId)
  if (settings.features?.motionArbitration !== true) motionAudioOwner = null
  if (settings.features?.silentReactions !== true || settings.autonomy?.focusMode === true) clearSilentReaction()
  if (wasInstantReaction && settings.features?.instantReaction !== true) instantReaction.invalidate()
  $('quickVoice').value = 'voice-a'
  avatar?.setMotionAmount?.(settings.avatar.motionAmount ?? 0.7)
  avatar?.setNaturalIdleEnabled?.(settings.features?.live2dNaturalIdle === true)
  avatar?.setEmotionPersistenceEnabled?.(settings.features?.emotionPersistence === true)
  $('charName').textContent = settings.character.name
  $('settingsSaved').textContent = '保存しました'
  $('setMemorySendContextToDeepSeek').disabled = settings.memory?.longTermEnabled !== true
  await refreshMemoryList()
  await checkVoicevox()
  await refreshThinkingFillerCache()
  if (prevMode !== settings.avatar.mode) await initAvatar()
  else if (avatar?.kind === 'png') initAvatar()
  setupRecognition()
})
$('setLongTermMemoryEnabled').addEventListener('change', () => {
  const enabled = $('setLongTermMemoryEnabled').checked
  $('setMemorySendContextToDeepSeek').disabled = !enabled
  if (!enabled) $('setMemorySendContextToDeepSeek').checked = false
})
$('btnAddMemory').addEventListener('click', async () => {
  const result = await api.addMemory({ type:$('manualMemoryType').value, content:$('manualMemoryContent').value })
  $('memoryStatus').textContent = result?.ok ? (result.item?.duplicate ? '同じ記憶があるため確認済みにしました' : '記憶を追加しました') : (result?.error || '記憶を追加できませんでした')
  if (result?.ok) { $('manualMemoryContent').value = ''; await refreshMemoryList() }
})
$('btnScanMemoryHistory').addEventListener('click', () => scanMemoryHistory().catch(error => {
  $('memoryStatus').textContent = `履歴を確認できません: ${String(error?.message || error).slice(0, 160)}`
}))
$('btnDeleteAllMemories').addEventListener('click', async () => {
  if (!window.confirm('このPCに保存した長期記憶をすべて削除します。この操作は取り消せません。続けますか？')) return
  const result = await api.clearMemories()
  $('memoryStatus').textContent = result?.ok ? 'すべての長期記憶を削除しました' : (result?.error || '削除できませんでした')
  await refreshMemoryList()
})
$('btnMode').addEventListener('click', async () => {
  fullMode = !fullMode
  await api.setWindowMode(fullMode ? 'full' : 'pet')
})
$('btnHide').addEventListener('click', () => api.hideWindow())
$('btnClearHistory').addEventListener('click', async () => {
  await api.clearHistory()
  $('chatLog').innerHTML = ''
  addSystemMessage('会話履歴を削除しました')
})
$('historySearch').addEventListener('input', async (e) => {
  const q = e.target.value.trim()
  const items = q ? await api.searchHistory(q) : await api.listHistory()
  $('chatLog').innerHTML = ''
  for (const item of items.slice(-100)) addMessage(item.role, item.content, item.ts)
  if (q) addSystemMessage(`「${q}」の検索結果: ${items.length} 件`)
})

$('quickVoice').addEventListener('change', async () => {
  settings.qwen.speaker = $('quickVoice').value
  settings = (await api.saveConfig(settings)).settings
  refreshThinkingFillerCache().catch(() => {})
})
let expressionPreviewTimer = null
$('btnMotionPreview').addEventListener('click', () => {
  if (speaking || previewing || !avatar) return
  const emotion = $('faceSelect').value === 'auto' ? 'neutral' : $('faceSelect').value
  setEmotion(emotion)
  const motion = ({ thinking: 'think', greeting: 'bow', shy: 'shy', confused: 'think' })[emotion]
  if (motion) avatar.playMotion(motion)
  clearTimeout(expressionPreviewTimer)
  expressionPreviewTimer = setTimeout(() => { if (!speaking && !previewing) setEmotion('neutral') }, 3500)
})
$('btnEmotionReset').addEventListener('click', () => {
  clearTimeout(expressionPreviewTimer)
  $('faceSelect').value = 'auto'
  automaticEmotion = { name: 'neutral', intensity: 1 }
  applySelectedEmotion()
})
$('btnVoicePreview').addEventListener('click', async () => {
  if (speaking || previewing) return
  ensureAudio()
  previewing = true
  $('btnVoicePreview').disabled = true
  try {
    const selected = $('faceSelect').value === 'auto' ? 'happy' : $('faceSelect').value
    setEmotion(selected)
    const motion = ({ thinking: 'think', greeting: 'bow', shy: 'shy', confused: 'think' })[selected]
    await playFastVoice('こんにちは、きみ。DeepSeekちゃんだよ。', motion)
    $('voiceProgress').textContent = '試聴が終わりました'
  } catch (e) {
    $('voiceProgress').textContent = String(e.message || e).replace(/Error invoking remote method '[^']+':\s*/g, '')
  } finally {
    previewing = false
    $('btnVoicePreview').disabled = false
    if ($('faceSelect').value === 'auto') setEmotion('neutral')
    processSpeakQueue().catch(console.error)
  }
})

init().catch((e) => {
  console.error(e)
  setStatus('初期化エラー')
  addSystemMessage('初期化でエラーが発生しました: ' + (e.message || e))
})
