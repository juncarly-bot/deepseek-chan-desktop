'use strict'

const LIVE2D_EMOTIONS = new Set(['neutral','happy','shy','excited','thinking','sleepy','proud','sad','annoyed','surprised','greeting','playful','flustered','confused','pout','angry','relaxed','worried','loving','crying'])

class Live2DAvatar {
  constructor(container) {
    this.container = container
    this.mouth = 0
    this.amount = 0.7
    this.speaking = false
    this.emotion = 'neutral'
    this.emotionIntensity = 0.8
    this.emotionPersistenceEnabled = false
    this.emotionChangedAt = 0
    this.emotionSource = 'conversation'
    this.emotionHeldUntil = null
    this.emotionDecayStartedAt = null
    this.emotionDecayDurationMs = 2200
    this.state = 'idle'
    this.stateMix = { idle: 1, listening: 0, thinking: 0, speaking: 0, reacting: 0 }
    this.expression = { mouth: 0.05, smile: 0, brow: 0, blush: 0, tears: 0, sweat: 0, hearts: 0, squint: 0, dizzy: 0, playful: 0, puff: 0, pucker: 0, gazeX: 0, gazeY: 0, eyeOpen: 0 }
    this.speakingLevel = 0
    this.blinkElapsed = -1
    this.blinkTimer = 2.6 + Math.random() * 2.2
    this.nod = null
    this.lastFrame = performance.now()
    this.motion = null
    this.earValues = null
    this.physicalPose = null
    this.facePose = null
    this.referencePose = { x: 0, y: 0, z: 0 }
    this.referenceTarget = { x: 0, y: 0, z: 0 }
    this.nextReferenceChange = 0
    this.emotionReaction = null
    this.naturalIdleEnabled = false
    this.motionArbiter = null
    this.random = Math.random
    this.nextIdleGestureAt = null
    this.idleGesture = null
    this.idleGestureFade = null
  }

  async load(url) {
    if (!window.PIXI?.live2d?.Live2DModel || !window.Live2DCubismCore) {
      throw new Error('Live2Dの表示部品を読み込めませんでした')
    }
    this.app = new PIXI.Application({
      width: 430, height: 680, transparent: true, antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5), autoDensity: true,
    })
    this.container.appendChild(this.app.view)
    this.model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false })
    // このモデルでは、鼻の補助用メッシュが黒い四角として描画される。
    // 元のモデルデータは変更せず、該当する二つの表示だけを抑える。
    const coreModel = this.model.internalModel.coreModel
    // Cubism の update() は beforeModelUpdate 後に保存済みパラメータを再ロードする。
    // 口パク・表情・視線をその復元後に戻し、描画へ反映させる。
    const loadParameters = coreModel.loadParameters?.bind(coreModel)
    if (loadParameters) {
      coreModel.loadParameters = (...args) => {
        const result = loadParameters(...args)
        if (this.facePose) {
          for (const [id, value] of Object.entries(this.facePose)) coreModel.setParameterValueById(id, value)
        }
        return result
      }
    }
    const hiddenMeshes = new Set(['ArtMesh246', 'ArtMesh682'])
    const drawableIds = coreModel.getDrawableIds().map(id => String(id.s || id))
    const originalOpacity = coreModel.getDrawableOpacity.bind(coreModel)
    coreModel.getDrawableOpacity = index => hiddenMeshes.has(drawableIds[index]) ? 0 : originalOpacity(index)
    this.app.stage.addChild(this.model)
    // 姿勢を物理演算の前にも渡し、髪や耳が上半身の動きに追従できるようにする。
    this.model.internalModel.on('afterMotionUpdate', () => {
      if (!this.physicalPose) return
      for (const [id, value] of Object.entries(this.physicalPose)) coreModel.setParameterValueById(id, value)
    })
    this.model.internalModel.on('beforeModelUpdate', () => {
      const core = this.model.internalModel.coreModel
      const now = performance.now()
      const seconds = now / 1000
      const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000))
      this.lastFrame = now
      const amount = this.amount
      const expressions = {
        neutral: { mouth: 0.05 }, happy: { mouth: 0.8, smile: 0.65, brow: 0.2, blush: 0.25 },
        shy: { mouth: 0.35, smile: 0.25, brow: 0.15, blush: 0.85, gazeX: 0.65, gazeY: -0.2 },
        excited: { mouth: 0.9, smile: 0.7, brow: 0.35, squint: 0.35, eyeOpen: 0.12 },
        thinking: { mouth: -0.05, brow: 0.3, gazeX: -0.55, gazeY: 0.65 },
        sleepy: { mouth: 0.12, brow: -0.08, eyeOpen: -0.38, gazeY: -0.25 },
        proud: { mouth: 0.48, smile: 0.38, brow: 0.32, gazeY: 0.18 },
        sad: { mouth: -0.55, brow: 0.6, gazeY: -0.55 },
        annoyed: { mouth: -0.5, brow: -0.65, gazeX: -0.65 },
        surprised: { mouth: 0.05, brow: 0.85, eyeOpen: 0.22 },
        greeting: { mouth: 0.55, smile: 0.5, brow: 0.12 },
        playful: { mouth: 0.6, smile: 0.25, brow: -0.1, playful: 0.75, gazeX: 0.18 },
        flustered: { mouth: 0.05, brow: 0.4, blush: 1, sweat: 0.4, gazeX: 0.5, eyeOpen: 0.12 },
        confused: { mouth: -0.15, brow: 0.7, dizzy: 0.35, gazeX: -0.2 },
        pout: { mouth: -0.8, brow: -0.18, blush: 0.35, puff: 0.8, pucker: 0.65, gazeX: 0.75 },
        // Existing tags remain accepted with their original appearance.
        angry: { mouth: -0.5, brow: -0.7 }, relaxed: { mouth: 0.4, smile: 0.35, brow: 0.05 },
        worried: { mouth: -0.35, brow: 0.55, sweat: 0.75 }, loving: { mouth: 0.8, smile: 0.45, blush: 0.6, hearts: 0.8 },
        crying: { mouth: -0.7, brow: 0.7, tears: 0.85 },
      }
      const target = expressions[this.emotion] || expressions.neutral
      const emotionIntensity = this.getEmotionRenderIntensity(now)
      const smoothing = 1 - Math.exp(-dt * 4.5)
      for (const key of Object.keys(this.expression)) {
        const baseline = expressions.neutral[key] ?? 0
        const desired = baseline + ((target[key] ?? 0) - baseline) * emotionIntensity
        this.expression[key] += (desired - this.expression[key]) * smoothing
      }
      this.speakingLevel += ((this.speaking ? 1 : 0) - this.speakingLevel) * smoothing
      for (const name of Object.keys(this.stateMix)) {
        const targetState = this.state === name ? 1 : 0
        this.stateMix[name] += (targetState - this.stateMix[name]) * (1 - Math.exp(-dt * 3.8))
      }
      const idle = this.stateMix.idle
      const listening = this.stateMix.listening
      const thinking = this.stateMix.thinking
      const speaking = Math.max(this.stateMix.speaking, this.speakingLevel)
      const reacting = this.stateMix.reacting
      const blink = this.updateBlink(dt)
      // 参考動画のように、ゆっくり向きを変えて少し留まり、また正面へ戻る。
      const pose = this.updateReferencePose(seconds, dt)
      // 配信画面でも伝わるように、前回よりもう一段だけ振幅を上げる。
      let headX = (pose.x * (idle + listening * 0.12 + reacting * 0.2) + Math.sin(seconds * 0.54) * (2.5 * idle + 0.9 * listening)) * amount * (1 - 0.9 * speaking)
      let headY = (pose.y * (idle + listening * 0.1) + Math.sin(seconds * 0.42) * (2.5 * idle + 1.0 * listening)) * amount
      let headZ = (pose.z * (idle + listening * 0.12 + reacting * 0.2) + Math.sin(seconds * 0.48) * (3.5 * idle + 1.15 * listening)) * amount
      let bodyX = (pose.x * 0.15 * idle + Math.sin(seconds * 0.4) * (7.0 * idle + 1.6 * listening)) * amount
      let bodyY = (Math.sin(seconds * 0.34 + 0.5) * (5.0 * idle + 1.6 * listening) - 1.6 * thinking) * amount
      let bodyZ = Math.sin(seconds * 0.48 - 0.3) * (6.5 * idle + 1.6 * listening) * amount
      const idleGesture = this.getIdleGestureOffsets(seconds)
      const idleWeight = this.motionArbiter ? idle : 1
      headY += idleGesture.headY * amount * idleWeight
      headZ += idleGesture.headZ * amount * idleWeight
      bodyX += idleGesture.bodyX * amount * idleWeight
      bodyY += idleGesture.bodyY * amount * idleWeight
      bodyZ += idleGesture.bodyZ * amount * idleWeight
      if (this.naturalIdleEnabled && this.state === 'idle') {
        // 既存の呼吸パラメータと同じ周期で、ごく小さな上半身の動きを重ねる。
        bodyY += Math.sin(seconds * 1.5 + 0.4) * 0.55 * amount
      }
      headZ += 6.5 * thinking * amount
      headY += 1.6 * listening * amount
      const speechBeat = speaking * amount
      headY += Math.sin(seconds * 3.1) * 2.6 * speechBeat
      headZ += Math.sin(seconds * 2.0) * 1.6 * speechBeat
      bodyX += Math.sin(seconds * 1.4) * 2.2 * speechBeat
      bodyY += Math.sin(seconds * 1.7) * 1.6 * speechBeat
      bodyZ += Math.sin(seconds * 1.25) * 1.6 * speechBeat
      const nod = this.getNodWeight(now) * (this.motionArbiter && !window.MotionArbitration.allows(this.nod?.source, this.state, this.speaking) ? 0 : 1)
      headY -= 8.0 * nod * amount
      bodyY -= 2.5 * nod * amount
      const reaction = this.getEmotionReaction(now)
      const reactionScale = 1.6
      headY += reaction.headY * amount * reactionScale
      headZ += reaction.headZ * amount * reactionScale
      bodyY += reaction.bodyY * amount * reactionScale
      bodyZ += reaction.bodyZ * amount * reactionScale
      if (this.motion) {
        const elapsed = (now - this.motion.start) / 1000
        const duration = this.motion.duration
        if (elapsed >= duration) this.motion = null
        else if (!this.motionArbiter || window.MotionArbitration.allows(this.motion.source, this.state, this.speaking)) {
          const weight = Math.max(0, Math.min(1, elapsed * 2, (duration - elapsed) * 2)) * Math.min(amount, 1)
          const name = this.motion.name
          if (name === 'bow') { headY -= 10 * weight; bodyY -= 4 * weight }
          if (name === 'think') { headZ += 9 * weight; headX += 4 * weight * (1 - this.speakingLevel) }
          if (name === 'shy') { headY -= 5 * weight; headZ -= 5 * weight }
          if (name === 'cheer') { headY += Math.sin(elapsed * 4) * 4 * weight }
        }
      }
      if (this.motionArbiter) {
        const smoothed = this.motionArbiter.smooth({ ParamAngleX:headX, ParamAngleY:headY, ParamAngleZ:headZ,
          ParamBodyAngleX:bodyX, ParamBodyAngleY:bodyY, ParamBodyAngleZ:bodyZ }, dt)
        ;({ ParamAngleX:headX, ParamAngleY:headY, ParamAngleZ:headZ,
          ParamBodyAngleX:bodyX, ParamBodyAngleY:bodyY, ParamBodyAngleZ:bodyZ } = smoothed)
      }
      core.setParameterValueById('ParamMouthOpenY', this.mouth)
      core.setParameterValueById('ParamMouthForm', this.expression.mouth - this.expression.pucker * 0.3)
      core.setParameterValueById('Mouthpucker', this.expression.pucker)
      core.setParameterValueById('CheeckPuff', this.expression.puff)
      core.setParameterValueById('EyeSmile', this.expression.smile)
      core.setParameterValueById('ParamBrowLY', this.expression.brow)
      core.setParameterValueById('ParamBrowRY', this.expression.brow)
      core.setParameterValueById('key7', this.expression.blush)
      core.setParameterValueById('key2', this.expression.tears)
      core.setParameterValueById('key13', this.expression.sweat)
      core.setParameterValueById('key4', this.expression.hearts)
      core.setParameterValueById('key5', this.expression.squint)
      core.setParameterValueById('key3', this.expression.dizzy)
      core.setParameterValueById('key6', this.expression.playful)
      core.setParameterValueById('REyeSquint', Math.max(0, -this.expression.eyeOpen))
      core.setParameterValueById('LEyeSquint', Math.max(0, -this.expression.eyeOpen))
      core.setParameterValueById('ShockR', Math.max(0, this.expression.eyeOpen))
      core.setParameterValueById('ShockL', Math.max(0, this.expression.eyeOpen))
      const eyeOpen = Math.max(0.25, 1 - Math.max(0, -this.expression.eyeOpen) * 0.55)
      core.setParameterValueById('ParamEyeROpen', eyeOpen * (1 - blink))
      core.setParameterValueById('ParamEyeLOpen', eyeOpen * (1 - blink))
      for (const id of ['ParamEyeBallX', 'ParamEyeBallY']) {
        const expressionGaze = 1 - listening * 0.82
        const glance = id === 'ParamEyeBallX'
          ? (pose.x / 24 * 0.2 * (1 - 0.85 * speaking) + this.expression.gazeX * 0.55 * expressionGaze) * amount
          : (pose.y / 8 * 0.1 * (1 - 0.7 * speaking) + this.expression.gazeY * 0.45 * expressionGaze) * amount
        core.setParameterValueById(id, Math.max(-1, Math.min(1, glance)))
      }
      core.setParameterValueById('ParamAngleX', headX)
      core.setParameterValueById('ParamAngleY', headY)
      core.setParameterValueById('ParamAngleZ', headZ)
      core.setParameterValueById('ParamBodyAngleX', bodyX)
      core.setParameterValueById('ParamBodyAngleY', bodyY)
      core.setParameterValueById('ParamBodyAngleZ', bodyZ)
      const breath = (Math.sin(seconds * 1.5) + 1) / 2 * Math.min(amount, 1)
      core.setParameterValueById('ParamBreath', breath)
      const faceParameterIds = ['ParamMouthOpenY','ParamMouthForm','Mouthpucker','CheeckPuff','EyeSmile',
        'ParamBrowLY','ParamBrowRY','key7','key2','key13','key4','key5','key3','key6',
        'REyeSquint','LEyeSquint','ShockR','ShockL','ParamEyeROpen','ParamEyeLOpen','ParamEyeBallX','ParamEyeBallY']
      this.facePose = Object.fromEntries(faceParameterIds.flatMap(id => {
        const value = core.getParameterValueById(id)
        return Number.isFinite(value) ? [[id, value]] : []
      }))
      this.physicalPose = { ParamAngleX: headX, ParamAngleY: headY, ParamAngleZ: headZ,
        ParamBodyAngleX: bodyX, ParamBodyAngleY: bodyY, ParamBodyAngleZ: bodyZ, ParamBreath: breath }
      this.smoothEarMotion(core, dt)
    })
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.resize()
  }

  resize() {
    if (!this.model || !this.app) return
    const width = this.container.clientWidth || 430
    const height = this.container.clientHeight || 680
    this.app.renderer.resize(width, height)
    // 配信画面のように頭から上半身を大きく見せる。
    const scale = height / this.model.internalModel.originalHeight * 2.05
    this.model.scale.set(scale)
    this.model.position.set((width - this.model.internalModel.originalWidth * scale) / 2, -height * 0.04)
  }

  setMouth(value) { this.mouth = Math.max(0, Math.min(1, Number(value) || 0)) }
  setState(value) {
    if (!['idle', 'listening', 'thinking', 'speaking', 'reacting'].includes(value)) return
    if (value !== 'idle' && this.state === 'idle') this.beginIdleGestureFade(performance.now() / 1000)
    this.state = value
    if (this.motionArbiter && value !== 'idle') {
      if (this.motion?.source === 'autonomy') this.motion = null
      if (this.nod?.source === 'autonomy') this.nod = null
    }
    if (value !== 'idle') {
      this.idleGesture = null
      this.nextIdleGestureAt = null
    } else if (this.naturalIdleEnabled && this.nextIdleGestureAt === null) {
      this.nextIdleGestureAt = performance.now() / 1000 + 18 + this.random() * 12
    }
  }
  setNaturalIdleEnabled(value) {
    if (value !== true) this.beginIdleGestureFade(performance.now() / 1000)
    this.naturalIdleEnabled = value === true
    if (!this.naturalIdleEnabled) this.idleGesture = null
    this.nextIdleGestureAt = this.naturalIdleEnabled && this.state === 'idle'
      ? performance.now() / 1000 + 18 + this.random() * 12
      : null
  }
  beginIdleGestureFade(seconds) {
    if (!this.idleGesture) return
    const offsets = this.getIdleGesturePose(this.idleGesture, seconds)
    const active = Object.values(offsets).some(value => Math.abs(value) > 0.001)
    this.idleGesture = null
    if (active) this.idleGestureFade = { offsets, start: seconds, duration: 0.32 }
  }
  getIdleGesturePose(gesture, seconds) {
    const zero = { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 }
    const progress = (seconds - gesture.start) / gesture.duration
    if (progress >= 1 || progress < 0) return zero
    const weight = Math.sin(Math.PI * progress)
    return { headY: gesture.headY * weight, headZ: gesture.headZ * weight,
      bodyX: gesture.bodyX * weight, bodyY: gesture.bodyY * weight,
      bodyZ: gesture.bodyZ * weight }
  }
  getIdleGestureFadeOffsets(seconds) {
    if (!this.idleGestureFade) return { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 }
    const progress = (seconds - this.idleGestureFade.start) / this.idleGestureFade.duration
    if (progress >= 1 || progress < 0) {
      this.idleGestureFade = null
      return { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 }
    }
    const weight = 1 - progress * progress * (3 - 2 * progress)
    return Object.fromEntries(Object.entries(this.idleGestureFade.offsets).map(([key, value]) => [key, value * weight]))
  }
  getIdleGestureOffsets(seconds) {
    const zero = { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 }
    if (!this.naturalIdleEnabled || this.state !== 'idle') return this.getIdleGestureFadeOffsets(seconds)
    const fade = this.getIdleGestureFadeOffsets(seconds)
    if (!this.idleGesture && this.nextIdleGestureAt !== null && seconds >= this.nextIdleGestureAt) {
      const poses = [
        { headY: 1.8, headZ: 1.4, bodyX: 0.45, bodyY: 0.6, bodyZ: 0.35 },
        { headY: -1.4, headZ: -1.8, bodyX: -0.35, bodyY: 0.4, bodyZ: -0.5 },
        { headY: 0.8, headZ: 2.0, bodyX: 0.6, bodyY: -0.25, bodyZ: 0.45 },
      ]
      const duration = 2.4 + this.random() * 0.9
      this.idleGesture = { ...poses[Math.floor(this.random() * poses.length)], start: seconds, duration }
      this.nextIdleGestureAt = seconds + duration + 18 + this.random() * 18
    }
    if (!this.idleGesture) return fade
    const progress = (seconds - this.idleGesture.start) / this.idleGesture.duration
    if (progress >= 1 || progress < 0) {
      this.idleGesture = null
      return fade
    }
    const gesture = this.getIdleGesturePose(this.idleGesture, seconds)
    return Object.fromEntries(Object.keys(zero).map(key => [key, gesture[key] + fade[key]]))
  }
  updateBlink(dt) {
    if (this.blinkElapsed < 0) {
      this.blinkTimer -= dt
      if (this.blinkTimer <= 0) this.blinkElapsed = 0
      return 0
    }
    this.blinkElapsed += dt
    const duration = 0.18
    const progress = this.blinkElapsed / duration
    if (progress >= 1) {
      this.blinkElapsed = -1
      this.blinkTimer = this.naturalIdleEnabled && this.state === 'idle'
        ? 3.1 + this.random() * 3.4
        : 2.6 + Math.random() * 3.4
      return 0
    }
    return Math.sin(Math.PI * progress)
  }
  getNodWeight(now) {
    if (!this.nod) return 0
    const elapsed = (now - this.nod.start) / 1000
    const progress = elapsed / this.nod.duration
    if (progress >= 1) { this.nod = null; return 0 }
    const strength = Number.isFinite(this.nod.strength) ? Math.max(0, Math.min(1, this.nod.strength)) : 1
    return Math.sin(Math.PI * Math.max(0, progress)) * strength
  }
  updateReferencePose(seconds, dt) {
    if (seconds >= this.nextReferenceChange) {
      if (this.naturalIdleEnabled && this.state === 'idle') {
        const forward = this.random() < 0.52
        this.referenceTarget = forward ? { x: 0, y: 0, z: 0 } : {
          x: (this.random() * 2 - 1) * 7,
          y: (this.random() * 2 - 1) * 3,
          z: (this.random() * 2 - 1) * 2.5,
        }
        this.nextReferenceChange = seconds + 5 + this.random() * 4
      } else {
        const forward = Math.random() < 0.4
        this.referenceTarget = forward ? { x: 0, y: 0, z: 0 } : {
          x: (Math.random() * 2 - 1) * 24,
          y: (Math.random() * 2 - 1) * 6,
          z: (Math.random() * 2 - 1) * 7,
        }
        this.nextReferenceChange = seconds + 2.8 + Math.random() * 3.2
      }
    }
    const follow = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) * 1.5)
    for (const axis of ['x', 'y', 'z']) {
      this.referencePose[axis] += (this.referenceTarget[axis] - this.referencePose[axis]) * follow
    }
    return this.referencePose
  }
  smoothEarMotion(core, dt) {
    // 物理演算の直後、左右の耳だけを少しずつ追従させる。
    const ids = ['LEar1', 'LEar2', 'LEar3', 'REar1', 'REar2', 'REar3']
    if (!this.earValues) this.earValues = Object.create(null)
    const blend = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) * 7)
    for (const id of ids) {
      const target = core.getParameterValueById(id)
      if (!Number.isFinite(target)) continue
      const previous = this.earValues[id]
      const value = previous === undefined ? target : previous + (target - previous) * blend
      this.earValues[id] = value
      core.setParameterValueById(id, value)
    }
  }
  setSpeaking(value) { this.speaking = Boolean(value) }
  setEmotion(value, intensity = 0.8, source = 'conversation') {
    const previous = this.emotion
    this.emotion = LIVE2D_EMOTIONS.has(value) ? value : 'neutral'
    const number = Number(intensity)
    this.emotionIntensity = Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.8
    this.emotionChangedAt = performance.now()
    this.emotionSource = String(source || 'conversation')
    this.emotionHeldUntil = null
    this.emotionDecayStartedAt = null
    if (this.emotion !== previous && this.emotion !== 'neutral') {
      this.emotionReaction = { name: this.emotion, start: this.emotionChangedAt, intensity: this.emotionIntensity }
    } else if (this.emotion === 'neutral') {
      this.emotionReaction = null
    }
  }
  setEmotionPersistenceEnabled(value) {
    this.emotionPersistenceEnabled = value === true
    if (!this.emotionPersistenceEnabled && this.emotionDecayStartedAt !== null) this.setEmotion('neutral')
  }
  releaseEmotion(now = performance.now()) {
    if (!this.emotionPersistenceEnabled || this.emotion === 'neutral') {
      this.setEmotion('neutral', 0.8, 'speech-end')
      return
    }
    this.emotionHeldUntil = now
    this.emotionDecayStartedAt = now
  }
  getEmotionRenderIntensity(now = performance.now()) {
    if (!this.emotionPersistenceEnabled || this.emotionDecayStartedAt === null) return this.emotionIntensity
    const duration = Math.max(1, this.emotionDecayDurationMs)
    const progress = Math.max(0, Math.min(1, (now - this.emotionDecayStartedAt) / duration))
    if (progress >= 1) {
      this.emotion = 'neutral'
      this.emotionIntensity = 0
      this.emotionSource = 'decay'
      this.emotionDecayStartedAt = null
      this.emotionReaction = null
      return 0
    }
    const remaining = 1 - progress
    return this.emotionIntensity * remaining * remaining
  }
  getEmotionReaction(now) {
    const empty = { headY: 0, headZ: 0, bodyY: 0, bodyZ: 0 }
    if (!this.emotionReaction) return empty
    const elapsed = (now - this.emotionReaction.start) / 1000
    if (elapsed >= 1.6) { this.emotionReaction = null; return empty }
    if (elapsed <= 0) return empty
    const poses = {
      happy: [3, 2.5, 1, 1.5], excited: [4, 3, 2, 2], proud: [2, -1, 1, 1],
      surprised: [5, -1, 3, -1], confused: [1, 5, 0, 1], thinking: [1, 5, 0, 1],
      greeting: [-4, 0, -1, 0], flustered: [2, 4, 1, 1], pout: [-1, 3, 0, -1],
      sleepy: [-2, 0, -1, 0], annoyed: [0, -4, 0, -1],
      shy: [-3, -4, -1, -1], loving: [2, 3, 1, 1.5],
      sad: [-4, -1, -2, -0.5], crying: [-5, -1.5, -2.5, -0.5],
      worried: [-2, 2.5, -1, 0.5], angry: [-1, -2, 0, -1],
      relaxed: [1, 2, 0.5, 1], playful: [2, -4, 1, -1.5],
    }
    const values = poses[this.emotionReaction.name] || [0, 0, 0, 0]
    const weight = Math.sin(Math.PI * elapsed / 1.6) * this.emotionReaction.intensity
    return { headY: values[0] * weight, headZ: values[1] * weight,
      bodyY: values[2] * weight, bodyZ: values[3] * weight }
  }
  setMotionAmount(value) { this.amount = Math.max(0, Math.min(1.5, Number(value) || 0)) }
  setMotionArbitrationEnabled(value) {
    if (value === true && !this.motionArbiter) this.motionArbiter = new window.MotionArbitration.Arbiter(this.physicalPose)
    else if (value !== true) this.motionArbiter = null
  }
  beginMotionTurn(id) {
    if (!this.motionArbiter) return
    this.motionArbiter.begin(id)
    this.motion = null; this.nod = null; this.emotionReaction = null
    this.mouth = 0; this.speaking = false
  }
  cancelMotionTurn(id) {
    if (!this.motionArbiter?.cancel(id)) return
    this.motion = null; this.nod = null; this.emotionReaction = null
    this.mouth = 0; this.speaking = false
  }
  cancelMotionSource(source, generationId = null) {
    if (!this.motionArbiter) return
    if (this.motion?.source === source && (!generationId || this.motion.generationId === generationId)) this.motion = null
    if (this.nod?.source === source && (!generationId || this.nod.generationId === generationId)) this.nod = null
  }
  playMotion(name, options = {}) {
    if (name !== 'nod' && !['bow', 'think', 'cheer', 'shy'].includes(name)) return
    const source = options.source || (this.speaking ? 'speech' : this.state === 'idle' ? 'autonomy' : 'reaction')
    if (this.motionArbiter) {
      if (options.generationId && !this.motionArbiter.isCurrent(options.generationId)) return
      if (!window.MotionArbitration.allows(source, this.state, this.speaking)) return
      const currentSources = [this.motion?.source, this.nod?.source].filter(Boolean)
      if (currentSources.some(current => !window.MotionArbitration.canReplace(current, source))) return
      if (this.motion && window.MotionArbitration.canReplace(this.motion.source, source)) this.motion = null
      if (this.nod && window.MotionArbitration.canReplace(this.nod.source, source)) this.nod = null
    }
    if (name === 'nod') {
      this.nod = { start: performance.now(), duration: 0.42 }
      if (this.motionArbiter) { this.nod.source = source; this.nod.generationId = options.generationId || null }
    } else if (['bow', 'think', 'cheer', 'shy'].includes(name)) {
      this.motion = { name, start: performance.now(), duration: 3 }
      if (this.motionArbiter) { this.motion.source = source; this.motion.generationId = options.generationId || null }
    }
  }
  dispose() {
    this.resizeObserver?.disconnect()
    this.model?.destroy({ children: true })
    this.app?.destroy(true, { children: true })
    this.container.innerHTML = ''
  }
}
window.Live2DAvatar = Live2DAvatar
