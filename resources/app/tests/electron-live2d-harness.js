'use strict'

const fs = require('node:fs')
const path = require('node:path')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function inRenderer(win, expression) {
  try {
    return await win.webContents.executeJavaScript(`(async () => { const avatar = window.__deepseekE2E?.getAvatar(); return (${expression}) })()`, true)
  } catch (error) {
    throw new Error(`Renderer evaluation failed for ${expression.slice(0, 100)}: ${error.message}`)
  }
}

async function waitForRenderer(win, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await inRenderer(win, expression)) return
    await wait(100)
  }
  throw new Error('Renderer did not reach the expected ready state')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeResult(resultPath, result) {
  const dataRoot = path.resolve(process.env.DEEPSEEK_QA_DATA || '')
  const resolved = path.resolve(resultPath || '')
  const relative = path.relative(dataRoot, resolved)
  if (!dataRoot || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('E2E result path must remain inside the isolated user-data directory')
  }
  fs.writeFileSync(resolved, JSON.stringify(result, null, 2), 'utf8')
}

async function openSettings(win) {
  return inRenderer(win, `(() => {
    document.getElementById('btnSettings').click()
    return document.getElementById('setNaturalIdle')?.checked
  })()`)
}

async function saveFlag(win, enabled, emotionPersistence, lowLatencySpeech, autonomy, desktopContext, thinkingFillers) {
  const fillerSetup = thinkingFillers === undefined ? '' : `
    document.getElementById('setThinkingFillersEnabled').checked = ${thinkingFillers.enabled ? 'true' : 'false'}
    document.getElementById('setThinkingFillersMode').value = '${thinkingFillers.mode || 'opening'}'
    document.getElementById('setThinkingFillerStartDelay').value = '${thinkingFillers.startDelayMs ?? 1000}'
    document.getElementById('setThinkingFillersFrequency').value = '${thinkingFillers.frequency ?? 0.35}'
    for (const input of document.querySelectorAll('[data-filler-id]')) input.checked = ${JSON.stringify(thinkingFillers.phrases || [])}.includes(input.dataset.fillerId)
  `
  const fillerAssertion = thinkingFillers === undefined ? 'true' : `config.settings.thinkingFillers?.enabled === ${thinkingFillers.enabled ? 'true' : 'false'}
      && config.settings.thinkingFillers?.mode === '${thinkingFillers.mode || 'opening'}'
      && config.settings.thinkingFillers?.startDelayMs === ${thinkingFillers.startDelayMs ?? 1000}
      && config.settings.thinkingFillers?.frequency === ${thinkingFillers.frequency ?? 0.35}
      && JSON.stringify(config.settings.thinkingFillers?.phrases) === JSON.stringify(${JSON.stringify(thinkingFillers.phrases || [])})`
  return inRenderer(win, `(async () => {
    const checkbox = document.getElementById('setNaturalIdle')
    if (!checkbox) throw new Error('Natural-idle setting checkbox is missing')
    checkbox.checked = ${enabled ? 'true' : 'false'}
    if (${emotionPersistence === undefined ? 'false' : 'true'}) {
      document.getElementById('setEmotionPersistence').checked = ${emotionPersistence ? 'true' : 'false'}
    }
    if (${lowLatencySpeech === undefined ? 'false' : 'true'}) {
      document.getElementById('setLowLatencySpeech').checked = ${lowLatencySpeech ? 'true' : 'false'}
    }
    if (${autonomy === undefined ? 'false' : 'true'}) {
      document.getElementById('setAutonomyActionsEnabled').checked = ${autonomy?.actionsEnabled ? 'true' : 'false'}
      document.getElementById('setAutonomyActionMinutes').value = ${autonomy?.actionIntervalMinutes || 5}
      document.getElementById('setAutonomyFocusMode').checked = ${autonomy?.focusMode ? 'true' : 'false'}
      document.getElementById('setIdleEnabled').checked = ${autonomy?.speechEnabled ? 'true' : 'false'}
      document.getElementById('setIdleMinutes').value = ${autonomy?.speechIntervalMinutes || 15}
    }
    if (${desktopContext === undefined ? 'false' : 'true'}) {
      document.getElementById('setDesktopContextEnabled').checked = ${desktopContext ? 'true' : 'false'}
    }
    ${fillerSetup}
    document.getElementById('btnSaveSettings').click()
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && document.getElementById('settingsSaved').textContent !== '保存しました') {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (document.getElementById('settingsSaved').textContent !== '保存しました') throw new Error('Settings save did not complete')
    const config = await api.getConfig()
    return config.settings.features?.live2dNaturalIdle === ${enabled ? 'true' : 'false'}
      && (${emotionPersistence === undefined ? 'true' : `config.settings.features?.emotionPersistence === ${emotionPersistence ? 'true' : 'false'}`})
      && (${lowLatencySpeech === undefined ? 'true' : `config.settings.features?.lowLatencySpeech === ${lowLatencySpeech ? 'true' : 'false'}`})
      && (${autonomy === undefined ? 'true' : `config.settings.autonomy?.actionsEnabled === ${autonomy?.actionsEnabled ? 'true' : 'false'}
        && config.settings.autonomy?.actionIntervalMinutes === ${autonomy?.actionIntervalMinutes || 5}
        && config.settings.autonomy?.focusMode === ${autonomy?.focusMode ? 'true' : 'false'}
        && config.settings.idleTalk?.enabled === ${autonomy?.speechEnabled ? 'true' : 'false'}
        && config.settings.idleTalk?.intervalMinutes === ${autonomy?.speechIntervalMinutes || 15}`})
      && (${desktopContext === undefined ? 'true' : `config.settings.desktopContext?.enabled === ${desktopContext ? 'true' : 'false'}`})
      && (${fillerAssertion})
  })()`)
}

async function inspectDesktopContext(win) {
  return inRenderer(win, `(async () => {
    const api = window.deepseekChan
    const disabled = await api.checkDesktopContextTestSample({ enabled:false, idleMs:900000, processName:'Code', fullscreen:false })
    const disabledDidNotRead = disabled.context.available === false && disabled.context.foregroundCategory === 'unknown'
      && disabled.context.ownWindowState === undefined
    const work = await api.checkDesktopContextTestSample({ enabled:true, actionsEnabled:true, speechEnabled:true,
      idleMs:900000, processName:'Code', fullscreen:false, appIdleMs:900000 })
    const workSuppressed = work.result === 'blocked' && work.policy.suppressSpeech
    const workPrivacySafe = work.context.foregroundCategory === 'study_work' && !('processName' in work.context)
    const game = await api.checkDesktopContextTestSample({ enabled:true, actionsEnabled:true, speechEnabled:true,
      idleMs:900000, processName:'VALORANT-Win64-Shipping', fullscreen:false, appIdleMs:900000, allowAction:true })
    const gamePreferred = game.result === 'action' && game.policy.preferredAction === 'nod'
    const longIdle = await api.checkDesktopContextTestSample({ enabled:true, actionsEnabled:true, speechEnabled:true,
      idleMs:31*60*1000, processName:'unknown-app', fullscreen:false, appIdleMs:31*60*1000, allowAction:true })
    const longIdleSuppressed = longIdle.result === 'blocked' && longIdle.policy.suppressActions && longIdle.policy.suppressSpeech
    const returned = await api.checkDesktopContextTestSample({ enabled:true, actionsEnabled:true, speechEnabled:false,
      previousIdleMs:360000, idleMs:5000, processName:null, fullscreen:false, appIdleMs:900000 })
    const returnReaction = returned.result === 'return-reaction'
    const failedUnknown = await api.checkDesktopContextTestSample({ enabled:true, actionsEnabled:false, speechEnabled:false,
      idleMs:null, processName:null, fullscreen:null, appIdleMs:900000 })
    const failureIsUnknown = failedUnknown.context.available === false && failedUnknown.context.foregroundCategory === 'unknown'
    return { disabledDidNotRead, workSuppressed, workPrivacySafe, gamePreferred,
      longIdleSuppressed, returnReaction, failureIsUnknown,
      ownWindowStatePresent: typeof work.context.ownWindowState?.visible === 'boolean' }
  })()`)
}

async function inspectEmotionPersistence(win) {
  return inRenderer(win, `(() => {
    const now = performance.now()
    avatar.setEmotion('happy', 0.8, 'conversation')
    const held = avatar.getEmotionRenderIntensity(now + 5000)
    avatar.releaseEmotion(now)
    const halfway = avatar.getEmotionRenderIntensity(now + 1100)
    const beforeEnd = avatar.emotion
    const finished = avatar.getEmotionRenderIntensity(now + avatar.emotionDecayDurationMs + 1)
    return { enabled: avatar.emotionPersistenceEnabled, held, halfway, beforeEnd,
      finished, afterEnd: avatar.emotion, source: avatar.emotionSource }
  })()`)
}

async function inspectStreamingSpeechAndInterrupt(win) {
  return inRenderer(win, `(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    window.__deepseekE2E.seedThinkingFillerCache()
    settings.thinkingFillers.frequency = 0.85
    const fillerGeneration = crypto.randomUUID()
    const fillerStarted = window.__deepseekE2E.startTestFiller(fillerGeneration)
    await wait(80)
    const fillerWasPlaying = window.__deepseekE2E.getPipeline().fillerActive
    await window.__deepseekE2E.interrupt()
    await wait(30)
    const fillerStoppedOnInterrupt = !window.__deepseekE2E.getPipeline().fillerActive && avatar.mouth === 0
    const gapFiller = await window.__deepseekE2E.playTestGapAnswer(crypto.randomUUID())
    localStorage.removeItem('deepseek-chan-filler-history-v1')
    settings.thinkingFillers = { enabled:true, mode:'opening', startDelayMs:550, frequency:0.85, phrases:['hmm','eto'] }
    const initial = window.__deepseekE2E.getPipeline()
    const firstResponse = window.__deepseekE2E.sendChat('E2E synthetic streaming turn one')
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && window.__deepseekE2E.getPipeline().playbackStarts <= initial.playbackStarts) await wait(20)
    const duringFirstPlayback = window.__deepseekE2E.getPipeline()
    if (duringFirstPlayback.playbackStarts <= initial.playbackStarts) throw new Error('First streamed sentence did not reach PCM playback')
    await wait(180)
    const beforeInterrupt = window.__deepseekE2E.getPipeline()
    const secondResponse = window.__deepseekE2E.sendChat('E2E synthetic interrupting turn two')
    await Promise.all([firstResponse, secondResponse])
    const afterNewResponse = window.__deepseekE2E.getPipeline()
    await window.__deepseekE2E.interrupt()
    await wait(100)
    const final = window.__deepseekE2E.getPipeline()
    return { lowLatencyEnabled: (await api.getConfig()).settings.features?.lowLatencySpeech === true,
      fillerStarted, fillerWasPlaying, fillerStoppedOnInterrupt, gapFiller,
      firstSentencePlayedBeforeFullAnswer: duringFirstPlayback.playbackStarts > initial.playbackStarts
        && duringFirstPlayback.chatResponsesCompleted === initial.chatResponsesCompleted,
      fillerPlayedDuringQwenAndDeepSeek:duringFirstPlayback.fillerWhileTtsAndLlm > 0,
      fillerTransitionedToAnswer:duringFirstPlayback.fillerTransitions > 0,
      prefetchedNextSentence: beforeInterrupt.prefetchStarts > initial.prefetchStarts,
      interruptApplied: afterNewResponse.interrupts > initial.interrupts,
      staleAudioObservedAndRejected: afterNewResponse.staleVoiceEvents > initial.staleVoiceEvents,
      speechStoppedAfterFinalInterrupt: !final.speaking && final.queued === 0,
      mouthClosedAfterInterrupt: avatar.mouth === 0,
      syntheticTiming: {
        openingFillerStartsMs:duringFirstPlayback.fillerStartElapsedMs
          .filter(event => event.position === 'opening' && event.llmActive && event.ttsActive)
          .map(event => event.elapsedMs),
        firstAnswerPlaybackMs:duringFirstPlayback.answerPlaybackElapsedMs,
        fillerToAnswerSilenceMs:duringFirstPlayback.fillerHandoffGapsMs.at(-1) ?? null,
        syntheticQwenDelayPerChunkMs:20,
        note:'E2Eの合成音声データによる値。実Qwen推論時間ではない。',
      },
      singleTtsWorker:duringFirstPlayback.maxActiveTtsStreams === 1,
      probe: { voiceRequests:final.voiceRequests, playbackStarts:final.playbackStarts,
        prefetchStarts:final.prefetchStarts, interrupts:final.interrupts,
        staleVoiceEvents:final.staleVoiceEvents, workerFinishes:final.workerFinishes,
        fillerStarts:final.fillerStarts, fillerWhileTtsAndLlm:final.fillerWhileTtsAndLlm,
        fillerTransitions:final.fillerTransitions } }
  })()`)
}

async function inspectVoiceDisabledStreaming(win) {
  return inRenderer(win, `(async () => {
    const wasEnabled = settings.voice.enabled
    settings.voice.enabled = false
    try {
      await window.__deepseekE2E.sendChat('E2E voice disabled')
      const state = window.__deepseekE2E.getPipeline()
      return { chatSendingCleared: state.chatSending === false,
        sendButtonEnabled: document.getElementById('btnSend').disabled === false,
        generationCleared: state.generationId === null }
    } finally { settings.voice.enabled = wasEnabled }
  })()`)
}

async function inspectAutonomy(win) {
  return inRenderer(win, `(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (speaking || chatSending || activeGenerationId)) await wait(25)
    const saved = (await api.getConfig()).settings
    const preconditions = { actionsEnabled:settings.autonomy?.actionsEnabled, focusMode:settings.autonomy?.focusMode,
      chatSending, speaking, listening, previewing, avatarReady:Boolean(avatar) }
    const originalFocus = settings.autonomy.focusMode
    const actionProbe = window.__deepseekE2E.getPipeline().autonomyActions
    const mainAction = await api.triggerAutonomyTestTick({ actionsEnabled:true, speechEnabled:true,
      idleMs:60_000, allowAction:true })
    const actionDeadline = Date.now() + 3000
    while (Date.now() < actionDeadline && window.__deepseekE2E.getPipeline().autonomyActions <= actionProbe) await wait(20)
    const mainActionObserved = window.__deepseekE2E.getPipeline().autonomyActions > actionProbe
    const focusSuppressed = await api.triggerAutonomyTestTick({ actionsEnabled:true, speechEnabled:false,
      focusMode:true, busy:false, idleMs:60_000, allowAction:true })
    const busySuppressed = await api.triggerAutonomyTestTick({ actionsEnabled:true, speechEnabled:false,
      focusMode:false, busy:true, idleMs:60_000, allowAction:true })
    const actionStarted = window.__deepseekE2E.autonomyAction('nod')
    settings.autonomy.focusMode = true
    const focusBlocked = !window.__deepseekE2E.autonomyAction('think')
    settings.autonomy.focusMode = originalFocus
    const unknownBlocked = !window.__deepseekE2E.autonomyAction('wave')
    return { actionsSaved: saved.autonomy.actionsEnabled === true,
      actionFrequencySaved: saved.autonomy.actionIntervalMinutes === 1,
      speechSaved: saved.idleTalk.enabled === true && saved.idleTalk.intervalMinutes === 5,
      actionStarted, focusBlocked, unknownBlocked, preconditions,
      mainActionTriggered:mainAction === 'action' && mainActionObserved,
      mainActionResult:mainAction,
      focusSuppressed:focusSuppressed === 'blocked', busySuppressed:busySuppressed === 'blocked' }
  })()`)
}

async function inspectAutonomySpeechInterrupt(win) {
  return inRenderer(win, `(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const originalLowLatency = settings.features.lowLatencySpeech
    settings.features.lowLatencySpeech = false
    const before = window.__deepseekE2E.getPipeline()
    const scheduled = await api.triggerAutonomyTestTick({ actionsEnabled:true, speechEnabled:true,
      idleMs:300_000, allowAction:false })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const state = window.__deepseekE2E.getPipeline()
      if (state.voiceRequests > before.voiceRequests && state.playbackStarts > before.playbackStarts) break
      await wait(20)
    }
    const during = window.__deepseekE2E.getPipeline()
    const input = document.getElementById('chatInput')
    input.value = '新しい入力で停止'
    input.dispatchEvent(new Event('input', { bubbles:true }))
    const typedDeadline = Date.now() + 3000
    while (Date.now() < typedDeadline && window.__deepseekE2E.getPipeline().autonomySpeech) await wait(20)
    const afterTyping = window.__deepseekE2E.getPipeline()
    const reply = window.__deepseekE2E.sendChat('E2E interrupt autonomous speech')
    const nextDeadline = Date.now() + 5000
    while (Date.now() < nextDeadline) {
      const state = window.__deepseekE2E.getPipeline()
      if (state.generationId && state.generationId !== during.generationId) break
      await wait(20)
    }
    const afterInput = window.__deepseekE2E.getPipeline()
    await reply
    const playbackDeadline = Date.now() + 5000
    while (Date.now() < playbackDeadline
      && window.__deepseekE2E.getPipeline().playbackStarts <= before.playbackStarts + 1) await wait(20)
    const afterReply = window.__deepseekE2E.getPipeline()
    await window.__deepseekE2E.interrupt()
    settings.features.lowLatencySpeech = originalLowLatency
    return { autonomySpeechScheduled:scheduled === 'speech',
      autonomySpeechStarted: during.autonomySpeech === true && during.voiceRequests > before.voiceRequests
        && during.playbackStarts > before.playbackStarts,
      typedInputInterrupted:!afterTyping.autonomySpeech && afterTyping.interrupts > before.interrupts,
      interruptStillInFlightWhenSent:afterTyping.interrupting === true,
      newInputCreatedNewGeneration: afterInput.generationId !== during.generationId,
      autoFlagClearedOnInput: afterInput.autonomySpeech === false,
      interruptCountIncreased: afterInput.interrupts > before.interrupts,
      normalModeReplyPlayed:afterReply.playbackStarts > before.playbackStarts + 1 }
  })()`)
}

async function inspectAnimation(win) {
  return inRenderer(win, `(async () => {
    const core = avatar.model.internalModel.coreModel
    const read = () => Object.fromEntries(['ParamAngleY','ParamAngleZ','ParamBodyAngleY','ParamBreath','ParamEyeBallX','ParamEyeBallY','ParamEyeROpen','ParamMouthOpenY'].map(id => [id, core.getParameterValueById(id)]))
    const finite = values => Object.values(values).every(Number.isFinite)
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    avatar.setState('idle')
    avatar.random = () => 0.9
    avatar.nextReferenceChange = performance.now() / 1000
    avatar.nextIdleGestureAt = performance.now() / 1000
    avatar.idleGesture = null
    avatar.blinkElapsed = 0.07
    const blinkSamples = []
    for (let i = 0; i < 12; i++) {
      avatar.app.ticker.update(performance.now())
      blinkSamples.push({ elapsed: avatar.blinkElapsed, state: avatar.state,
        open: core.getParameterValueById('ParamEyeROpen'), captured: avatar.facePose?.ParamEyeROpen })
      await wait(10)
    }
    const before = read()
    await wait(600)
    const after = read()
    const idleGestureStarted = avatar.idleGesture !== null
    const parameterChanged = ['ParamAngleY','ParamAngleZ','ParamBodyAngleY','ParamBreath','ParamEyeBallX','ParamEyeBallY'].some(id => Math.abs(after[id] - before[id]) > 0.0001)
    const blinkMoved = blinkSamples.some(sample => Number.isFinite(sample.open) && sample.open < 0.99)
    avatar.setState('speaking')
    const fading = avatar.getIdleGestureOffsets(performance.now() / 1000).headY !== 0 || avatar.getIdleGestureOffsets(performance.now() / 1000).headZ !== 0
    await wait(400)
    const stopped = Object.values(avatar.getIdleGestureOffsets(performance.now() / 1000)).every(value => Math.abs(value) < 0.0001)
    const emotions = ['neutral','happy','shy','excited','thinking','sleepy','proud','sad','annoyed','surprised','greeting','playful','flustered','confused','pout']
    for (const emotion of emotions) {
      avatar.setEmotion(emotion, 0.73)
      if (avatar.emotion !== emotion || avatar.emotionIntensity !== 0.73) throw new Error('Emotion tag was not preserved: ' + emotion)
      if (!Object.values(avatar.expression).every(Number.isFinite)) throw new Error('Emotion produced a non-finite expression: ' + emotion)
    }
    avatar.setEmotion('happy', 0.85)
    avatar.setSpeaking(true)
    avatar.setState('speaking')
    const mouthLevels = [0.15, 0.72, 0.38, 0]
    const mouthObserved = []
    for (const level of mouthLevels) {
      avatar.setMouth(level)
      await wait(80)
      mouthObserved.push(core.getParameterValueById('ParamMouthOpenY'))
    }
    avatar.setSpeaking(false)
    avatar.setMouth(0)
    const mouthStayedIndependent = mouthObserved.every((value, i) => Number.isFinite(value) && Math.abs(value - mouthLevels[i]) < 0.03)
    return { finiteParameters: finite(after), parameterChanged, blinkMoved, idleGestureStarted, fading, stopped,
      all15EmotionsAccepted: true, mouthStayedIndependent, mouthObserved, blinkSamples }
  })()`)
}

async function inspectDisabled(win) {
  return inRenderer(win, `(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    avatar.setState('idle')
    avatar.setNaturalIdleEnabled(false)
    await wait(400)
    const offsets = avatar.getIdleGestureOffsets(performance.now() / 1000)
    const core = avatar.model.internalModel.coreModel
    const breathBefore = core.getParameterValueById('ParamBreath')
    await wait(300)
    const breathAfter = core.getParameterValueById('ParamBreath')
    return { disabled: avatar.naturalIdleEnabled === false,
      addedOffsetsCleared: Object.values(offsets).every(value => Math.abs(value) < 0.0001),
      legacyBreathStillUpdates: Number.isFinite(breathBefore) && Number.isFinite(breathAfter) && Math.abs(breathAfter - breathBefore) > 0.0001 }
  })()`)
}

module.exports = async function runElectronLive2DE2E(win, app) {
  const stage = process.env.DEEPSEEK_E2E_STAGE
  const resultPath = process.env.DEEPSEEK_E2E_RESULT
  await waitForRenderer(win, `avatar?.kind === 'live2d' && Boolean(avatar?.model?.internalModel?.coreModel)`)
  await waitForRenderer(win, `Boolean(window.deepseekChan)`)

  let result
  if (stage === 'save-on') {
    const defaultState = await inRenderer(win, `(async () => {
      const config = await api.getConfig()
      return { savedFlag: config.settings.features?.live2dNaturalIdle === true,
        avatarFlag: avatar.naturalIdleEnabled === true,
        emotionSaved: config.settings.features?.emotionPersistence === true,
        emotionFlag: avatar.emotionPersistenceEnabled === true,
        lowLatencySaved: config.settings.features?.lowLatencySpeech === true,
        fillersSaved: config.settings.thinkingFillers?.enabled === true,
        autonomyActionsSaved: config.settings.autonomy?.actionsEnabled === true,
        autonomyFocusSaved: config.settings.autonomy?.focusMode === true,
        idleTalkSaved: config.settings.idleTalk?.enabled === true,
        desktopEnabled: config.settings.desktopContext?.enabled === true }
    })()`)
    assert(!defaultState.savedFlag && !defaultState.avatarFlag && !defaultState.emotionSaved && !defaultState.emotionFlag
      && !defaultState.lowLatencySaved && !defaultState.fillersSaved && !defaultState.autonomyActionsSaved && !defaultState.autonomyFocusSaved && !defaultState.idleTalkSaved && !defaultState.desktopEnabled,
      'New isolated profile did not start with the features OFF')
    assert(await openSettings(win) === false, 'Settings UI did not show the OFF default')
    assert(await saveFlag(win, true, true, true, { actionsEnabled:true, actionIntervalMinutes:1,
      focusMode:false, speechEnabled:true, speechIntervalMinutes:5 }, true,
      { enabled:true, mode:'opening-gap', startDelayMs:1500, frequency:0.85, phrases:['hmm','eto'] }), 'ON setting was not saved')
    const enabled = await inRenderer(win, `(async () => ({ saved: (await api.getConfig()).settings.features?.live2dNaturalIdle === true,
      avatar: avatar.naturalIdleEnabled === true,
      emotionSaved: (await api.getConfig()).settings.features?.emotionPersistence === true,
      emotion: avatar.emotionPersistenceEnabled === true,
      lowLatency: (await api.getConfig()).settings.features?.lowLatencySpeech === true,
      fillers: (await api.getConfig()).settings.thinkingFillers?.enabled === true }))()`)
    assert(enabled.saved && enabled.avatar && enabled.emotionSaved && enabled.emotion && enabled.lowLatency && enabled.fillers,
      'ON setting was not applied to the avatar')
    const emotion = await inspectEmotionPersistence(win)
    assert(emotion.enabled && Math.abs(emotion.held - 0.8) < 0.001
      && Math.abs(emotion.halfway - 0.2) < 0.001 && emotion.beforeEnd === 'happy'
      && emotion.finished === 0 && emotion.afterEnd === 'neutral',
    'Emotion persistence/decay did not behave as expected: ' + JSON.stringify(emotion))
    const animation = await inspectAnimation(win)
    for (const key of ['finiteParameters','parameterChanged','blinkMoved','idleGestureStarted','fading','stopped','all15EmotionsAccepted','mouthStayedIndependent']) {
      assert(animation[key] === true, 'Phase 1 integration check failed: ' + key + ' ' + JSON.stringify(animation))
    }
    const streaming = await inspectStreamingSpeechAndInterrupt(win)
    for (const key of ['lowLatencyEnabled','firstSentencePlayedBeforeFullAnswer','prefetchedNextSentence',
      'fillerStarted','fillerWasPlaying','fillerStoppedOnInterrupt','fillerPlayedDuringQwenAndDeepSeek','fillerTransitionedToAnswer',
      'singleTtsWorker','interruptApplied','staleAudioObservedAndRejected','speechStoppedAfterFinalInterrupt','mouthClosedAfterInterrupt']) {
      assert(streaming[key] === true, 'Phase 3 integration check failed: ' + key + ' ' + JSON.stringify(streaming))
    }
    assert(streaming.gapFiller.started && streaming.gapFiller.activeBeforeAnswer && streaming.gapFiller.ended
      && streaming.gapFiller.gapStartCount > 0 && streaming.gapFiller.gapTransitionCount > 0,
    'Gap filler did not hand off to cached answer audio: ' + JSON.stringify(streaming.gapFiller))
    const voiceDisabled = await inspectVoiceDisabledStreaming(win)
    assert(voiceDisabled.chatSendingCleared && voiceDisabled.sendButtonEnabled && voiceDisabled.generationCleared,
      'Low-latency mode did not recover chat state when voice output was disabled')
    const autonomy = await inspectAutonomy(win)
    assert(autonomy.actionsSaved && autonomy.actionFrequencySaved && autonomy.speechSaved
      && autonomy.actionStarted && autonomy.focusBlocked && autonomy.unknownBlocked
      && autonomy.mainActionTriggered && autonomy.focusSuppressed && autonomy.busySuppressed,
    'Autonomy controls or action guards failed: ' + JSON.stringify(autonomy))
    const autonomySpeech = await inspectAutonomySpeechInterrupt(win)
    for (const key of ['autonomySpeechScheduled','autonomySpeechStarted','typedInputInterrupted',
      'interruptStillInFlightWhenSent','newInputCreatedNewGeneration','autoFlagClearedOnInput',
      'interruptCountIncreased','normalModeReplyPlayed']) {
      assert(autonomySpeech[key] === true, 'Autonomous speech interruption failed: ' + key + ' ' + JSON.stringify(autonomySpeech))
    }
    const desktop = await inspectDesktopContext(win)
    for (const key of ['disabledDidNotRead','workSuppressed','workPrivacySafe','gamePreferred',
      'longIdleSuppressed','returnReaction','failureIsUnknown','ownWindowStatePresent']) {
      assert(desktop[key] === true, 'Desktop context check failed: ' + key + ' ' + JSON.stringify(desktop))
    }
    const instant = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      document.getElementById('btnSettings').click()
      const box = document.getElementById('setInstantReaction')
      const defaultOff = !box.checked
      box.checked = true
      document.getElementById('settingsSaved').textContent = ''
      document.getElementById('btnSaveSettings').click()
      for (let i = 0; i < 100 && document.getElementById('settingsSaved').textContent !== '保存しました'; i++) await wait(50)
      const saved = (await api.getConfig()).settings.features?.instantReaction === true
      const start = performance.now()
      const pending = window.__deepseekE2E.sendChat('テストです。')
      const elapsedMs = performance.now() - start
      const immediate = avatar.state
      await wait(100)
      const second = window.__deepseekE2E.sendChat('次のテストです。')
      const interruptedInput = avatar.state
      await wait(650)
      const later = avatar.state
      await window.__deepseekE2E.interrupt()
      await Promise.all([pending, second])
      const afterInterrupt = avatar.state
      const core = avatar.model.internalModel.coreModel
      let emotionsAndMouth = true
      for (const emotion of ['neutral','happy','shy','excited','thinking','sleepy','proud','sad','annoyed','surprised','greeting','playful','flustered','confused','pout']) {
        avatar.setEmotion(emotion, 0.8)
        avatar.setMouth(0.4)
        await wait(25)
        emotionsAndMouth &&= Number.isFinite(core.getParameterValueById('ParamAngleZ'))
          && Number.isFinite(core.getParameterValueById('ParamMouthOpenY')) && Math.abs(avatar.mouth - 0.4) < 0.01
      }
      avatar.setMotionAmount(0.7)
      avatar.setMouth(0)
      avatar.setEmotion('neutral')
      document.getElementById('btnSettings').click()
      box.checked = false
      document.getElementById('settingsSaved').textContent = ''
      document.getElementById('btnSaveSettings').click()
      for (let i = 0; i < 100 && document.getElementById('settingsSaved').textContent !== '保存しました'; i++) await wait(50)
      return { defaultOff, saved, immediate, interruptedInput, later, afterInterrupt, elapsedMs, emotionsAndMouth,
        restoredOff: (await api.getConfig()).settings.features?.instantReaction === false }
    })()`)
    assert(instant.defaultOff && instant.saved && instant.immediate === 'listening' && instant.interruptedInput === 'listening'
      && instant.later === 'thinking' && instant.afterInterrupt === 'idle' && instant.emotionsAndMouth && instant.restoredOff,
      'Instant reaction integration failed: ' + JSON.stringify(instant))
    result = { stage, defaultOff: true, settingsSavedOn: true, emotionPersistenceDefaultOff: true,
      emotionPersistenceSavedOn: true, emotionDecay: emotion, enabledAfterSave: true,
      ...animation, streamingSpeech:streaming, voiceDisabled, autonomy, autonomySpeech, desktopContext:desktop, instant,
      realQwenAudioPlayed: false, externalApiCalled: false }
  } else if (stage === 'restore-on-disable') {
    const checked = await openSettings(win)
    assert(checked === true, 'ON setting was not restored after app restart')
    const state = await inRenderer(win, `(async () => ({ saved: (await api.getConfig()).settings.features?.live2dNaturalIdle === true,
      avatar: avatar.naturalIdleEnabled === true,
      emotionSaved: (await api.getConfig()).settings.features?.emotionPersistence === true,
      emotion: avatar.emotionPersistenceEnabled === true,
      emotionCheckbox: document.getElementById('setEmotionPersistence')?.checked === true,
      lowLatencySaved: (await api.getConfig()).settings.features?.lowLatencySpeech === true,
      lowLatencyCheckbox: document.getElementById('setLowLatencySpeech')?.checked === true,
      fillersSaved: (await api.getConfig()).settings.thinkingFillers?.enabled === true,
      fillersCheckbox: document.getElementById('setThinkingFillersEnabled')?.checked === true,
      autonomyActionsSaved: (await api.getConfig()).settings.autonomy?.actionsEnabled === true,
      autonomyActionsCheckbox: document.getElementById('setAutonomyActionsEnabled')?.checked === true,
      autonomyFocusSaved: (await api.getConfig()).settings.autonomy?.focusMode === true,
      idleTalkSaved: (await api.getConfig()).settings.idleTalk?.enabled === true,
      desktopEnabled: (await api.getConfig()).settings.desktopContext?.enabled === true,
      desktopCheckbox: document.getElementById('setDesktopContextEnabled')?.checked === true }))()`)
    assert(state.saved && state.avatar && state.emotionSaved && state.emotion && state.emotionCheckbox
      && state.lowLatencySaved && state.lowLatencyCheckbox && state.fillersSaved && state.fillersCheckbox
      && state.autonomyActionsSaved && state.autonomyActionsCheckbox
      && state.desktopEnabled && state.desktopCheckbox
      && !state.autonomyFocusSaved && state.idleTalkSaved,
      'ON setting did not survive process restart')
    const enabledAnimation = await inspectAnimation(win)
    for (const key of ['finiteParameters','parameterChanged','blinkMoved','idleGestureStarted','fading','stopped']) {
      assert(enabledAnimation[key] === true, 'Restored ON animation check failed: ' + key)
    }
    assert(await saveFlag(win, false, false, false, { actionsEnabled:false, actionIntervalMinutes:1,
      focusMode:false, speechEnabled:false, speechIntervalMinutes:5 }, false,
      { enabled:false, mode:'opening-gap', startDelayMs:1500, frequency:0.35, phrases:['hmm','eto'] }), 'OFF setting was not saved')
    const disabled = await inspectDisabled(win)
    assert(disabled.disabled && disabled.addedOffsetsCleared && disabled.legacyBreathStillUpdates,
      'OFF mode did not return to legacy animation behavior')
    result = { stage, restoredOn: true, emotionPersistenceRestoredOn: true,
      settingsSavedOff: true, emotionPersistenceSavedOff: true, ...disabled,
      emotionAndMouthChecks: enabledAnimation.all15EmotionsAccepted && enabledAnimation.mouthStayedIndependent,
      realQwenAudioPlayed: false, externalApiCalled: false }
  } else if (stage === 'arbitration') {
    const arbitration = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const defaultOff = (await api.getConfig()).settings.features?.motionArbitration === false && !avatar.motionArbiter
      async function configure(enabled) {
        document.getElementById('btnSettings').click()
        document.getElementById('setMotionArbitration').checked = enabled
        document.getElementById('setInstantReaction').checked = true
        document.getElementById('setAdaptiveVoice').checked = true
        document.getElementById('setSilentReactions').checked = true
        document.getElementById('setLowLatencySpeech').checked = true
        document.getElementById('settingsSaved').textContent = ''
        document.getElementById('btnSaveSettings').click()
        for (let i = 0; i < 100 && document.getElementById('settingsSaved').textContent !== '保存しました'; i++) await wait(50)
        return (await api.getConfig()).settings.features?.motionArbitration === enabled
      }
      const saved = await configure(true)
      settings.voice.enabled = true
      avatar.setState('idle')
      avatar.playMotion('bow', { source:'autonomy' })
      const hadAutonomy = avatar.motion?.source === 'autonomy'
      const pending = window.__deepseekE2E.sendChat('E2E first arbitration')
      const oldMotionCleared = !avatar.motion || avatar.motion.source !== 'autonomy'
      await wait(100)
      await window.__deepseekE2E.interrupt()
      await pending
      let repeatedInterrupts = true
      for (let i = 0; i < 10; i++) {
        const turn = window.__deepseekE2E.sendChat('E2E turn ' + i)
        await wait(55)
        await window.__deepseekE2E.interrupt()
        await turn
        repeatedInterrupts &&= avatar.mouth === 0 && !avatar.speaking && !avatar.motionArbiter.generation
      }
      const core = avatar.model.internalModel.coreModel
      let all15EmotionsSafe = true
      for (const emotion of ['neutral','happy','shy','excited','thinking','sleepy','proud','sad','annoyed','surprised','greeting','playful','flustered','confused','pout']) {
        avatar.setEmotion(emotion, 0.85)
        avatar.setMouth(0.4)
        await wait(20)
        all15EmotionsSafe &&= avatar.emotion === emotion && Number.isFinite(core.getParameterValueById('ParamAngleZ'))
          && Number.isFinite(core.getParameterValueById('ParamMouthOpenY')) && Math.abs(avatar.mouth - 0.4) < 0.01
      }
      avatar.setMouth(0)
      avatar.setEmotion('neutral')
      const filler = await window.__deepseekE2E.playTestGapAnswer('motion-arbitration-filler')
      const quickCue = await window.__deepseekE2E.playTestQuickCue('motion-arbitration-quick-cue')
      let repeatedPCMInterrupts = true
      for (let i = 0; i < 10; i++) {
        const interrupted = await window.__deepseekE2E.interruptTestPCM('motion-arbitration-pcm-' + i)
        repeatedPCMInterrupts &&= interrupted.playbackStarted && interrupted.interrupted && interrupted.mouthClosed && interrupted.speakingStopped
      }
      const closedAfterFiller = avatar.mouth === 0 && !avatar.speaking
      const oldAvatar = avatar
      await initAvatar()
      const fresh = window.__deepseekE2E.getAvatar()
      const reloadRestored = fresh !== oldAvatar && Boolean(fresh.motionArbiter) && fresh.mouth === 0
      const disabled = await configure(false)
      const off = !fresh.motionArbiter
      return { defaultOff, saved, hadAutonomy, oldMotionCleared, repeatedInterrupts,
        all15EmotionsSafe, filler, quickCue, repeatedPCMInterrupts, closedAfterFiller, reloadRestored, disabled, off }
    })()`)
    for (const key of ['defaultOff','saved','hadAutonomy','oldMotionCleared','repeatedInterrupts','all15EmotionsSafe','repeatedPCMInterrupts','closedAfterFiller','reloadRestored','disabled','off']) {
      assert(arbitration[key] === true, 'Motion arbitration integration failed: ' + key + ' ' + JSON.stringify(arbitration))
    }
    assert(arbitration.filler.started && arbitration.filler.activeBeforeAnswer && arbitration.filler.ended,
      'Filler handoff failed under motion arbitration: ' + JSON.stringify(arbitration.filler))
    assert(arbitration.quickCue.emotionApplied && arbitration.quickCue.motionApplied,
      'A cue near the start of PCM was lost: ' + JSON.stringify(arbitration.quickCue))
    result = { stage, arbitrationPassed:true, ...arbitration, realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'memory') {
    const memory = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const configBefore = await api.getConfig()
      const defaultOff = configBefore.settings.memory?.longTermEnabled === false
        && configBefore.settings.memory?.sendContextToDeepSeek === false
      document.getElementById('btnSettings').click()
      for (let i=0;i<100 && !document.getElementById('memoryStoragePath').textContent.includes('long-term-memory.json');i++) await wait(30)
      const storagePathVisible = Boolean(document.getElementById('memoryStoragePath').textContent.includes('long-term-memory.json'))
      document.getElementById('btnScanMemoryHistory').click()
      for (let i=0;i<100 && ![...document.querySelectorAll('#memoryCandidates .memory-row')].length;i++) await wait(30)
      const candidate = [...document.querySelectorAll('#memoryCandidates .memory-row')].find(el => el.textContent.includes('電磁気学の試験'))
      const candidateOnlyFromUser = Boolean(candidate) && ![...document.querySelectorAll('#memoryCandidates .memory-row')].some(el => el.textContent.includes('応援している'))
      candidate?.querySelector('button')?.click()
      for (let i=0;i<100 && !(await api.listMemories()).items.length;i++) await wait(30)
      const listed = (await api.listMemories()).items.some(item => item.content.includes('電磁気学の試験'))
      const remainingCandidates = await api.scanMemoryHistory()
      const partialCandidateRemains = remainingCandidates.candidates.some(row => row.candidate.type === 'user_fact'
        && row.candidate.content.includes('物理学'))
      window.confirm = () => true
      document.getElementById('setLongTermMemoryEnabled').checked = true
      document.getElementById('setMemorySendContextToDeepSeek').checked = false
      document.getElementById('settingsSaved').textContent = ''
      document.getElementById('btnSaveSettings').click()
      for (let i=0;i<100 && document.getElementById('settingsSaved').textContent !== '保存しました';i++) await wait(50)
      const saved = await api.getConfig()
      return { defaultOff, storagePathVisible, listed, candidateOnlyFromUser, partialCandidateRemains,
        featureEnabled:saved.settings.memory?.longTermEnabled === true,
        apiSharingOff:saved.settings.memory?.sendContextToDeepSeek === false,
        sendCheckboxEnabled:document.getElementById('setMemorySendContextToDeepSeek').disabled === false }
    })()`)
    assert(memory.defaultOff && memory.storagePathVisible && memory.listed && memory.candidateOnlyFromUser && memory.partialCandidateRemains && memory.featureEnabled
      && memory.apiSharingOff && memory.sendCheckboxEnabled,
      'Long-term memory settings and UI failed: ' + JSON.stringify(memory))
    result = { stage, memoryPassed:true, ...memory, realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'memory-restore') {
    const memory = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const config = await api.getConfig()
      const result = await api.listMemories()
      const persisted = config.settings.memory?.longTermEnabled === true
        && config.settings.memory?.sendContextToDeepSeek === false
        && result.items.some(item => item.content.includes('電磁気学の試験') && item.sourceMessageId === 'memory-e2e-user-1')
      const item = result.items.find(row => row.content.includes('電磁気学の試験'))
      const updated = item && await api.updateMemory(item.id, { content:'物理学と電磁気学を勉強している', status:'active' })
      const updatedVisible = updated?.ok && (await api.listMemories()).items.some(row => row.content === '物理学と電磁気学を勉強している')
      const deleted = item && await api.deleteMemory(item.id)
      const deletedVisible = deleted && !(await api.listMemories()).items.some(row => row.id === item.id)
      const added = await api.addMemory({ type:'preference', content:'途中式を含めた説明が好み' })
      const cleared = added?.ok && await api.clearMemories()
      const empty = (await api.listMemories()).items.length === 0
      document.getElementById('btnSettings').click()
      document.getElementById('setLongTermMemoryEnabled').checked = false
      document.getElementById('setLongTermMemoryEnabled').dispatchEvent(new Event('change'))
      document.getElementById('settingsSaved').textContent = ''
      document.getElementById('btnSaveSettings').click()
      for (let i=0;i<100 && document.getElementById('settingsSaved').textContent !== '保存しました';i++) await wait(50)
      const stopped = (await api.getConfig()).settings.memory?.longTermEnabled === false
        && (await api.getConfig()).settings.memory?.sendContextToDeepSeek === false
      return { persisted, updatedVisible, deletedVisible, cleared:cleared?.ok === true, empty, stopped }
    })()`)
    assert(memory.persisted && memory.updatedVisible && memory.deletedVisible && memory.cleared && memory.empty && memory.stopped,
      'Long-term memory restore and CRUD failed: ' + JSON.stringify(memory))
    result = { stage, memoryRestoredPassed:true, ...memory, realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'followup') {
    const followUp = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const card = document.getElementById('followUpCard')
      const defaultOff = (await api.getConfig()).settings.proactive?.followUpsEnabled === false
        && document.getElementById('setFollowUpsEnabled').checked === false
      const originalConfirm = window.confirm
      window.confirm = () => true
      try {
        document.getElementById('btnSettings').click()
        document.getElementById('setFollowUpsEnabled').checked = true
        document.getElementById('setFollowUpDelivery').value = 'bubble'
        document.getElementById('setFollowUpQuietEnabled').checked = false
        document.getElementById('setLongTermMemoryEnabled').checked = true
        document.getElementById('setMemorySendContextToDeepSeek').checked = false
        document.getElementById('settingsSaved').textContent = ''
        document.getElementById('btnSaveSettings').click()
        for (let i=0;i<100 && document.getElementById('settingsSaved').textContent !== '保存しました';i++) await wait(50)
      } finally { window.confirm = originalConfirm }
      const saved = (await api.getConfig()).settings
      const memory = await api.addMemory({ type:'open_loop', content:'電磁気学の試験準備', status:'active',
        expiresAt:new Date(Date.now() - 2 * 86400000).toISOString() })
      if (!memory?.ok) throw new Error('Follow-up test memory could not be seeded')
      const memoryOffSuppressed = await api.triggerFollowUpTestTick({ enabled:true, memoryEnabled:false, idleMs:900000 })
      const focusSuppressed = await api.triggerFollowUpTestTick({ enabled:true, memoryEnabled:true, focusMode:true, idleMs:900000 })
      const delivered = await api.triggerFollowUpTestTick({ enabled:true, memoryEnabled:true, idleMs:900000 })
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && card.hidden) await wait(25)
      const visible = !card.hidden && document.getElementById('followUpText').textContent.includes('電磁気学の試験準備')
      const actionsVisible = ['completed','working','mute','edit'].every(action => Boolean(card.querySelector('[data-follow-up-action="' + action + '"]')))
        && Boolean(document.getElementById('btnLaterFollowUp'))
      document.querySelector('[data-follow-up-action="working"]').click()
      for (let i=0;i<100 && !card.hidden;i++) await wait(20)
      const updated = (await api.listMemories()).items.find(row => row.id === memory.item.id)
      const state = await api.proactiveState()
      return { defaultOff, settingsSaved:saved.proactive?.followUpsEnabled === true && saved.proactive?.delivery === 'bubble'
          && saved.memory?.longTermEnabled === true && saved.memory?.sendContextToDeepSeek === false,
        memoryOffSuppressed:memoryOffSuppressed === 'blocked', focusSuppressed:focusSuppressed === 'blocked', delivered:delivered === 'follow-up-bubble', visible,
        actionsVisible, responseUpdated:updated?.status === 'active' && Date.parse(updated.followUpAt) > Date.now() && card.hidden,
        countPersisted:state.todayCount === 1, externalApiCalled:false }
    })()`)
    assert(followUp.defaultOff && followUp.settingsSaved && followUp.memoryOffSuppressed && followUp.focusSuppressed && followUp.delivered
      && followUp.visible && followUp.actionsVisible && followUp.responseUpdated && followUp.countPersisted,
      'Proactive follow-up integration failed: ' + JSON.stringify(followUp))
    result = { stage, followUpPassed:true, ...followUp, realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'followup-restore') {
    const followUp = await inRenderer(win, `(async () => {
      const config = (await api.getConfig()).settings
      const state = await api.proactiveState()
      const memories = await api.listMemories()
      const item = memories.items.find(row => row.content === '電磁気学の試験準備')
      const suppressed = await api.triggerFollowUpTestTick({ enabled:true, memoryEnabled:true, idleMs:900000 })
      return { settingsRestored:config.proactive?.followUpsEnabled === true && config.proactive?.delivery === 'bubble'
          && config.memory?.longTermEnabled === true,
        dailyCountRestored:state.todayCount === 1, responseMemoryRetained:item?.status === 'active',
        snoozeRestored:suppressed === 'blocked', cardHidden:document.getElementById('followUpCard').hidden,
        externalApiCalled:false }
    })()`)
    assert(followUp.settingsRestored && followUp.dailyCountRestored && followUp.responseMemoryRetained
      && followUp.snoozeRestored && followUp.cardHidden,
      'Proactive follow-up restart restore failed: ' + JSON.stringify(followUp))
    result = { stage, followUpRestoredPassed:true, ...followUp, realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'calendar') {
    const calendar = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const panel = document.getElementById('calendarPanel')
      const defaultOff = (await api.getConfig()).settings.calendar?.shareWithAssistant === false
        && document.getElementById('calendarShareWithAssistant').checked === false
      document.getElementById('btnCalendar').click()
      for (let i = 0; i < 100 && panel.classList.contains('hidden'); i++) await wait(20)
      for (let i = 0; i < 150 && document.querySelectorAll('#calendarGrid .calendar-day').length !== 42; i++) await wait(20)
      const panelReady = !panel.classList.contains('hidden') && document.querySelectorAll('#calendarGrid .calendar-day').length === 42
      const monthReady = document.getElementById('calendarMonthTitle').textContent.length > 0
      const memory = await api.addMemory({ type:'open_loop', content:'E2Eレポート関連記憶', status:'active' })
      if (!memory?.ok) throw new Error('Could not seed isolated long-term memory for calendar linking')
      document.getElementById('btnNewCalendarEvent').click()
      for (let i = 0; i < 100 && !document.querySelector('#calendarLinkedMemory option[value="' + memory.item.id + '"]'); i++) await wait(20)
      document.getElementById('calendarLinkedMemory').value = memory.item.id
      document.getElementById('calendarEventTitle').value = 'E2E電磁気レポート'
      document.getElementById('calendarCategory').value = 'assignment'
      document.getElementById('calendarCategory').dispatchEvent(new Event('change'))
      document.getElementById('calendarTaskStatus').value = 'in_progress'
      document.getElementById('calendarHasStart').checked = false
      document.getElementById('calendarHasStart').dispatchEvent(new Event('change'))
      const localDate = date => String(date.getFullYear()) + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0')
      const plusDays = (date, days) => { const copy = new Date(date); copy.setDate(copy.getDate()+days); return copy }
      const due = plusDays(new Date(), 2); due.setHours(23, 59, 0, 0)
      document.getElementById('calendarDeadline').value = localDate(due) + 'T23:59'
      calendarSelectedDate = localDate(due)
      calendarMonthCursor = new Date(due.getFullYear(), due.getMonth(), 1)
      document.getElementById('calendarForm').requestSubmit()
      for (let i = 0; i < 150 && !document.getElementById('calendarAgenda').textContent.includes('E2E電磁気レポート'); i++) await wait(25)
      const taskVisible = document.getElementById('calendarAgenda').textContent.includes('E2E電磁気レポート')
      document.getElementById('calendarSearchQuery').value = 'E2E電磁気レポート'
      document.getElementById('btnCalendarSearch').click()
      for (let i = 0; i < 100 && !document.getElementById('calendarSearchResults').textContent.includes('E2E電磁気レポート'); i++) await wait(20)
      const searchWorks = document.getElementById('calendarSearchResults').querySelectorAll('.calendar-event-row').length === 1
      document.querySelector('#calendarSearchResults .calendar-event-row').click()
      for (let i = 0; i < 100 && document.getElementById('calendarForm').hidden; i++) await wait(20)
      const searchOpensEditor = !document.getElementById('calendarForm').hidden && document.getElementById('calendarEventTitle').value === 'E2E電磁気レポート'
      document.getElementById('btnCancelCalendarEdit').click()
      const today = new Date(); today.setHours(0,0,0,0)
      const firstDate = plusDays(today, 1)
      const recurrenceStart = localDate(firstDate)
      const weekDay = firstDate.getDay()
      const recurrenceEnd = localDate(plusDays(firstDate, 14))
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const start = await api.resolveCalendarLocalTime(recurrenceStart, '10:20', zone)
      const end = await api.resolveCalendarLocalTime(recurrenceStart, '11:50', zone)
      if (!start?.ok || !end?.ok) throw new Error('Could not resolve local recurring lesson time')
      const series = await api.addCalendarEvent({ title:'E2E週次授業', category:'lesson', startAt:start.iso, endAt:end.iso,
        startDate:recurrenceStart, endDate:recurrenceStart, timeZone:zone, recurrence:{ frequency:'weekly', weekdays:[weekDay],
          startDate:recurrenceStart, endDate:recurrenceEnd, startTime:'10:20', endTime:'11:50' } })
      if (!series?.ok) throw new Error(series?.error || 'Recurring lesson could not be created')
      const secondDate = localDate(plusDays(firstDate, 7))
      const firstOccurrence = (await api.calendarDate(recurrenceStart)).items.find(row => row.parentId === series.item.id)
      const secondOccurrence = (await api.calendarDate(secondDate)).items.find(row => row.parentId === series.item.id)
      if (!firstOccurrence || !secondOccurrence) throw new Error('Weekly recurrence did not expand')
      const deletedOne = await api.deleteCalendarOccurrence(firstOccurrence.occurrenceId)
      const changedOne = await api.updateCalendarOccurrence(secondOccurrence.occurrenceId, { title:'E2E休講振替授業' })
      const afterFirst = (await api.calendarDate(recurrenceStart)).items.some(row => row.parentId === series.item.id)
      const afterSecond = (await api.calendarDate(secondDate)).items.find(row => row.parentId === series.item.id)
      document.getElementById('calendarSearchQuery').value = 'E2E週次授業'
      document.getElementById('btnCalendarSearch').click()
      for (let i = 0; i < 100 && !document.getElementById('calendarSearchResults').textContent.includes('E2E週次授業'); i++) await wait(20)
      const seriesSearchRow = [...document.querySelectorAll('#calendarSearchResults .calendar-event-row')]
        .find(row => row.textContent.includes('E2E週次授業'))
      seriesSearchRow?.click()
      for (let i = 0; i < 100 && document.getElementById('calendarForm').hidden; i++) await wait(20)
      const recurrenceSearchOpensSeries = !document.getElementById('calendarForm').hidden
        && !document.getElementById('calendarEditScopeWrap').hidden && document.getElementById('calendarEditScope').value === 'series'
      document.getElementById('btnCancelCalendarEdit').click()
      const summary = await api.calendarSummary()
      const state = await api.calendarE2EState()
      const memoryLinkedEvent = state.events.find(row => row.title === 'E2E電磁気レポート')
      const disposable = await api.addCalendarEvent({ title:'E2E関連記憶削除確認', category:'other', allDay:true,
        startDate:recurrenceStart, endDate:recurrenceStart, timeZone:zone, linkedMemoryId:memory.item.id })
      const deletedDisposable = disposable?.ok && await api.deleteCalendarEvent(disposable.item.id)
      const memoryRetainedAfterCalendarDelete = (await api.listMemories()).items.some(row => row.id === memory.item.id)
      return { defaultOff, panelReady, monthReady, taskVisible, searchWorks, searchOpensEditor, recurrenceSearchOpensSeries,
        taskPersisted:state.events.some(row => row.title === 'E2E電磁気レポート' && row.taskStatus === 'in_progress'),
        memoryLinked:memoryLinkedEvent?.linkedMemoryId === memory.item.id, memoryRetainedAfterCalendarDelete:deletedDisposable?.ok === true && memoryRetainedAfterCalendarDelete,
        recurrenceExpanded:!!firstOccurrence && !!secondOccurrence, singleDelete:deletedOne?.ok && !afterFirst,
        singleEdit:changedOne?.ok && afterSecond?.title === 'E2E休講振替授業', summaryHas7Days:Array.isArray(summary.next7Days),
        localOnly:state.status.storagePath.includes('calendar.json') && state.status.count === 2,
        externalApiCalled:false, realQwenAudioPlayed:false }
    })()`)
    assert(calendar.defaultOff && calendar.panelReady && calendar.monthReady && calendar.taskVisible && calendar.searchWorks
      && calendar.searchOpensEditor && calendar.recurrenceSearchOpensSeries && calendar.taskPersisted
      && calendar.memoryLinked && calendar.memoryRetainedAfterCalendarDelete && calendar.recurrenceExpanded && calendar.singleDelete
      && calendar.singleEdit && calendar.summaryHas7Days && calendar.localOnly,
      'Local calendar Electron integration failed: ' + JSON.stringify(calendar))
    result = { stage, calendarPassed:true, ...calendar, externalApiCalled:false, realQwenAudioPlayed:false }
  } else if (stage === 'calendar-restore') {
    const calendar = await inRenderer(win, `(async () => {
      const state = await api.calendarE2EState()
      const task = state.events.find(row => row.title === 'E2E電磁気レポート')
      const memory = (await api.listMemories()).items.find(row => row.content === 'E2Eレポート関連記憶')
      const series = state.events.find(row => row.title === 'E2E週次授業')
      const exceptionDates = Object.keys(series?.exceptions || {})
      const exceptionDeleteRestored = exceptionDates.some(date => series.exceptions[date].cancelled === true)
      const exceptionEditRestored = exceptionDates.some(date => series.exceptions[date].override?.title === 'E2E休講振替授業')
      const recurring = series ? await api.calendarDate(series.recurrence.startDate) : { items:[] }
      return { settingsRestored:state.settings?.shareWithAssistant === false,
        taskRestored:task?.taskStatus === 'in_progress' && task.linkedMemoryId === memory?.id, seriesRestored:!!series?.recurrence,
        exceptionsRestored:exceptionDeleteRestored && exceptionEditRestored,
        recurrenceCanBeQueried:Array.isArray(recurring.items), externalApiCalled:false }
    })()`)
    assert(calendar.settingsRestored && calendar.taskRestored && calendar.seriesRestored && calendar.exceptionsRestored
      && calendar.recurrenceCanBeQueried, 'Local calendar restart restoration failed: ' + JSON.stringify(calendar))
    result = { stage, calendarRestoredPassed:true, ...calendar, externalApiCalled:false, realQwenAudioPlayed:false }
  } else if (stage === 'calendar-presence') {
    const presence=await inRenderer(win, `(async () => {
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
      const initial=(await api.getConfig()).settings.calendarPresence
      const defaultOff=['briefingEnabled','classQuietEnabled','deadlineRemindersEnabled','examRemindersEnabled',
        'eventRemindersEnabled','automaticFollowUpsEnabled','studyRivalEnabled','voiceEnabled','allowCloudVoice']
        .every(key=>initial?.[key]===false)
      document.getElementById('btnCalendar').click()
      await wait(100)
      document.getElementById('btnCalendarBriefing').click()
      await wait(100)
      const manualBriefing=!document.getElementById('calendarBriefing').hidden
        && document.getElementById('calendarBriefing').textContent.trim().length>0
      const before=await api.calendarPresenceHistory()
      const paused=await api.pauseCalendarPresence()
      const pausePersisted=(await api.calendarPresenceHistory()).paused===true
      const resumed=await api.resumeCalendarPresence()
      const resumePersisted=(await api.calendarPresenceHistory()).paused===false
      const notices=[]
      const stopNotices=api.onCalendarPresenceNotice(payload=>notices.push({kind:payload.kind,
        cardVisible:!document.getElementById('calendarPresenceCard').hidden,
        text:document.getElementById('calendarPresenceText').textContent}))
      const scenario=await api.calendarPresenceE2EScenario()
      stopNotices()
      const reminderDelivered=notices.some(payload=>payload.kind==='deadline'&&payload.cardVisible&&payload.text.includes('E2E assignment'))
      const later=document.querySelector('#calendarPresenceCard [data-calendar-presence-action="later"]')
      const laterAvailable=Boolean(later&&!later.hidden)
      later?.click()
      for(let i=0;i<40&&!document.getElementById('calendarPresenceCard').hidden;i++) await wait(25)
      const responseHandled=laterAvailable&&document.getElementById('calendarPresenceCard').hidden
      const budget=await api.calendarPresenceE2EBudgetCheck()
      const runtimePolicy=scenario.classQuietResult==='class-quiet'&&scenario.result==='calendar-deadline'
        &&scenario.noticeEmitted===true&&responseHandled&&budget.budgetBlockedBySharedGuard&&budget.result==='blocked'
      document.getElementById('btnCalendar').click()
      document.getElementById('btnSettings').click()
      document.getElementById('setCalendarBriefingEnabled').checked=true
      document.getElementById('setCalendarClassQuietEnabled').checked=true
      document.getElementById('setCalendarDeadlinesEnabled').checked=true
      document.getElementById('setCalendarReminderLead').value='120'
      document.getElementById('setCalendarQuietEnabled').checked=true
      document.getElementById('settingsSaved').textContent=''
      document.getElementById('btnSaveSettings').click()
      for(let i=0;i<100&&document.getElementById('settingsSaved').textContent!=='保存しました';i++) await wait(50)
      const saved=(await api.getConfig()).settings.calendarPresence
      return {defaultOff,manualBriefing,beforeWritable:before.writable===true,pausePersisted:paused.ok&&pausePersisted,
        resumePersisted:resumed.ok&&resumePersisted,settingsSaved:saved.briefingEnabled&&saved.classQuietEnabled
          &&saved.deadlineRemindersEnabled&&saved.reminderLeadMinutes===120&&saved.voiceEnabled===false
          &&saved.allowCloudVoice===false,runtimePolicy,reminderDelivered,responseHandled,externalApiCalled:false,realQwenAudioPlayed:false}
    })()`)
    assert(presence.defaultOff&&presence.manualBriefing&&presence.runtimePolicy&&presence.reminderDelivered
      &&presence.beforeWritable&&presence.pausePersisted
      &&presence.resumePersisted&&presence.settingsSaved,'Calendar presence Electron integration failed: '+JSON.stringify(presence))
    result={stage,calendarPresencePassed:true,...presence}
  } else if (stage === 'silent') {
    const silent = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const bubble = document.getElementById('silentReactionBubble')
      async function configure(enabled, focus = false) {
        document.getElementById('btnSettings').click()
        document.getElementById('setSilentReactions').checked = enabled
        document.getElementById('setInstantReaction').checked = true
        document.getElementById('setAdaptiveVoice').checked = true
        document.getElementById('setDesktopContextEnabled').checked = false
        document.getElementById('setAutonomyFocusMode').checked = focus
        document.getElementById('settingsSaved').textContent = ''
        document.getElementById('btnSaveSettings').click()
        for (let i = 0; i < 100 && document.getElementById('settingsSaved').textContent !== '保存しました'; i++) await wait(50)
        return (await api.getConfig()).settings.features?.silentReactions === enabled
      }
      const defaultOff = (await api.getConfig()).settings.features?.silentReactions === false && bubble.hidden
      const saved = await configure(true)
      const allowed = await api.silentReactionAllowed()
      settings.voice.enabled = false
      const pending = window.__deepseekE2E.sendChat('テストです。')
      const nod = Boolean(avatar.nod)
      const listening = avatar.state === 'listening'
      await wait(800)
      const thinking = avatar.state === 'thinking'
      const bubbleShown = !bubble.hidden && bubble.textContent === '考え中…'
      let emotionsAndMouth = true
      const core = avatar.model.internalModel.coreModel
      for (const emotion of ['neutral','happy','shy','excited','thinking','sleepy','proud','sad','annoyed','surprised','greeting','playful','flustered','confused','pout']) {
        avatar.setEmotion(emotion, 0.8)
        avatar.setMouth(0.4)
        await wait(25)
        emotionsAndMouth &&= Number.isFinite(core.getParameterValueById('ParamMouthOpenY'))
          && Number.isFinite(core.getParameterValueById('ParamAngleZ')) && Math.abs(avatar.mouth - 0.4) < 0.01
      }
      avatar.setMouth(0)
      await window.__deepseekE2E.interrupt()
      await pending
      const hiddenOnInterrupt = bubble.hidden
      await configure(true, true)
      const focusBlocked = !(await api.silentReactionAllowed())
      await configure(false, false)
      const disabled = !(await api.silentReactionAllowed()) && bubble.hidden
      return { defaultOff, saved, allowed, nod, listening, thinking, bubbleShown, emotionsAndMouth, hiddenOnInterrupt, focusBlocked, disabled }
    })()`)
    for (const key of ['defaultOff','saved','allowed','nod','listening','thinking','bubbleShown','emotionsAndMouth','hiddenOnInterrupt','focusBlocked','disabled']) {
      assert(silent[key] === true, 'Silent reaction integration failed: ' + key + ' ' + JSON.stringify(silent))
    }
    result = { stage, silentPassed:true, ...silent, realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'adaptive') {
    const comparison = await inRenderer(win, `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const captured = []
      const original = addSpeechPlans
      addSpeechPlans = (plans, generationId) => { captured.push(...plans.map(plan => plan.text)); return original(plans, generationId) }
      async function run(enabled, input = '同じ質問です。', lowLatency = true) {
        document.getElementById('btnSettings').click()
        document.getElementById('setAdaptiveVoice').checked = enabled
        document.getElementById('setSilentReactions').checked = enabled && lowLatency
        document.getElementById('setLowLatencySpeech').checked = lowLatency
        document.getElementById('setInstantReaction').checked = true
        document.getElementById('setThinkingFillersEnabled').checked = true
        document.getElementById('setThinkingFillersMode').value = 'opening'
        document.getElementById('setThinkingFillersFrequency').value = '0.85'
        document.getElementById('settingsSaved').textContent = ''
        document.getElementById('btnSaveSettings').click()
        for (let i = 0; i < 100 && document.getElementById('settingsSaved').textContent !== '保存しました'; i++) await wait(50)
        const saved = (await api.getConfig()).settings.features?.adaptiveVoiceResponse === enabled
        captured.length = 0
        const pending = window.__deepseekE2E.sendChat(input)
        const immediate = avatar.state
        let fillerStarted = false
        if (enabled && lowLatency) {
          window.__deepseekE2E.seedThinkingFillerCache()
          const bubble = document.getElementById('silentReactionBubble')
          bubble.hidden = false
          bubble.classList.add('visible')
          const id = window.__deepseekE2E.getPipeline().generationId
          const savedRandom = Math.random
          try { Math.random = () => 0; fillerStarted = window.__deepseekE2E.startTestFiller(id) }
          finally { Math.random = savedRandom }
        }
        const bubbleHiddenDuringFiller = !fillerStarted || document.getElementById('silentReactionBubble').hidden
        await wait(400)
        const earlyPlans = captured.length
        await pending
        await wait(500)
        const detail = [...document.querySelectorAll('.msg.assistant')].at(-1).textContent
        const result = { saved, immediate, earlyPlans, detail, fillerStarted, bubbleHiddenDuringFiller, plans:[...captured] }
        await window.__deepseekE2E.interrupt()
        return result
      }
      try { return { on:await run(true), off:await run(false), full:await run(true, '全文を読み上げて'),
        adaptiveOnly:await run(true, '同じ質問です。', false) } }
      finally { addSpeechPlans = original }
    })()`)
    const onText = comparison.on.plans.join('')
    const offText = comparison.off.plans.join('')
    assert(comparison.on.saved && comparison.off.saved && comparison.on.immediate === 'listening' && comparison.on.fillerStarted && comparison.on.bubbleHiddenDuringFiller
      && comparison.on.earlyPlans > 0 && onText === '一文目のテストです。'
      && offText === '一文目のテストです。二文目も続きます。最後のテスト文です。'
      && comparison.full.plans.join('') === offText
      && comparison.adaptiveOnly.plans.join('') === onText && comparison.adaptiveOnly.earlyPlans > 0
      && comparison.on.detail === comparison.off.detail && comparison.on.detail === offText,
    'Adaptive voice comparison failed: ' + JSON.stringify(comparison))
    result = { stage, adaptivePassed:true, onChars:[...onText].length, offChars:[...offText].length,
      earlyPlanBeforeReply:true, detailUnchanged:true, instantListening:true,
      realQwenAudioPlayed:false, externalApiCalled:false }
  } else if (stage === 'restore-off') {
    const checked = await openSettings(win)
    const state = await inRenderer(win, `(async () => ({ saved: (await api.getConfig()).settings.features?.live2dNaturalIdle === true,
      avatar: avatar.naturalIdleEnabled === true,
      emotionSaved: (await api.getConfig()).settings.features?.emotionPersistence === true,
      emotion: avatar.emotionPersistenceEnabled === true,
      emotionCheckbox: document.getElementById('setEmotionPersistence')?.checked === true,
      lowLatencySaved: (await api.getConfig()).settings.features?.lowLatencySpeech === true,
      lowLatencyCheckbox: document.getElementById('setLowLatencySpeech')?.checked === true,
      autonomyActionsSaved: (await api.getConfig()).settings.autonomy?.actionsEnabled === true,
      autonomyFocusSaved: (await api.getConfig()).settings.autonomy?.focusMode === true,
      idleTalkSaved: (await api.getConfig()).settings.idleTalk?.enabled === true,
      desktopEnabled: (await api.getConfig()).settings.desktopContext?.enabled === true,
      desktopCheckbox: document.getElementById('setDesktopContextEnabled')?.checked === true }))()`)
    assert(checked === false && !state.saved && !state.avatar && !state.emotionSaved && !state.emotion && !state.emotionCheckbox
      && !state.lowLatencySaved && !state.lowLatencyCheckbox && !state.autonomyActionsSaved
      && !state.autonomyFocusSaved && !state.idleTalkSaved && !state.desktopEnabled && !state.desktopCheckbox,
      'OFF setting was not restored after app restart')
    const disabled = await inspectDisabled(win)
    assert(disabled.disabled && disabled.addedOffsetsCleared && disabled.legacyBreathStillUpdates,
      'Restored OFF mode did not preserve legacy motion')
    result = { stage, restoredOff: true, ...disabled, realQwenAudioPlayed: false, externalApiCalled: false }
  } else {
    throw new Error('Unknown E2E stage')
  }

  writeResult(resultPath, result)
  await wait(100)
  app.quit()
}
