/**
 * avatar-vrm.js — VRM アバター表示＋口パク（three.js + @pixiv/three-vrm）
 *
 * DeepSeekちゃん VRM 1.0 モデル（tegnike/deepseek-chan-vrm, CC BY-NC-SA 4.0）を読み込み、
 * - 口パク: 表情 'aa' を発話音量で駆動（モデルには あいうえお 表情が含まれる）
 * - 感情: happy / angry / sad / relaxed / surprised のプリセット表情を切替
 * - まばたき: 'blink' をランダム間隔で実行
 * - モーション: wave（右手を振る）など簡易プロシージャルモーション
 * three.js は同梱。動きはフレーム時間で平滑化し、休止姿勢へ自然に戻す。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

const EMOTION_PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

class VrmAvatar {
  constructor(container) {
    this.container = container
    this.vrm = null
    this.mouth = 0
    this.mouthTarget = 0
    this.emotion = 'neutral'
    this.clock = new THREE.Clock()
    this.blinkTimer = 0
    this.blinkValue = 0
    this.motion = null // { name, until }
    this.disposed = false
    this.motionAmount = 0.7
    this.speakingTarget = 0
    this.speakingLevel = 0
    this.blinkTimer = 1.8
    this.blinkElapsed = -1
    this.gaze = new THREE.Object3D()
    this.gaze.position.set(0, 1.35, 2.6)
    this.nextGaze = 0
    this.gazeX = 0
    this.gazeY = 1.35
  }

  async load(url) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
    this.renderer = renderer
    this.container.appendChild(renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30)
    this.camera.position.set(0, 1.42, 2.3)
    this.camera.lookAt(0, 1.34, 0)

    const light = new THREE.DirectionalLight(0xffffff, 2.2)
    light.position.set(1, 2, 2)
    this.scene.add(light)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9))

    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)
    const vrm = gltf.userData.vrm
    if (!vrm) throw new Error('VRM データが見つかりませんでした')
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    // VRM 1.0 モデルは +Z 方向を向いているため、回転なしでカメラ（+Z側）に正対する
    this.scene.add(vrm.scene)
    // 初期ポーズ: Tポーズの腕を自然に下ろす
    const poseArm = (name, z) => {
      const b = vrm.humanoid?.getNormalizedBoneNode(name)
      if (b) b.rotation.z = z
    }
    poseArm('leftUpperArm', -1.15)
    poseArm('rightUpperArm', 1.15)
    this.restArmZ = { left: -1.15, right: 1.15 }
    this.vrm = vrm
    this.scene.add(this.gaze)
    if (vrm.lookAt) vrm.lookAt.target = this.gaze
    this.bones = {}
    for (const name of ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']) {
      this.bones[name] = vrm.humanoid?.getNormalizedBoneNode(name)
    }

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.loop()
  }

  resize() {
    if (!this.renderer) return
    const w = this.container.clientWidth || 360
    const h = this.container.clientHeight || 300
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  setMouth(level) {
    this.mouthTarget = Math.max(0, Math.min(1, level))
  }

  setEmotion(name) {
    this.emotion = EMOTION_PRESETS.includes(name) ? name : 'neutral'
  }

  setSpeaking(value) { this.speakingTarget = value ? 1 : 0 }
  setMotionAmount(value) { this.motionAmount = Math.max(0, Math.min(1.5, Number(value) || 0)) }

  playMotion(name) {
    if (['wave', 'bow', 'think', 'cheer', 'shy', 'clap'].includes(name)) {
      this.motion = { name, start: performance.now(), duration: name === 'wave' ? 3000 : 2300 }
    }
  }

  loop() {
    if (this.disposed) return
    this.raf = requestAnimationFrame(() => this.loop())
    const dt = Math.min(this.clock.getDelta(), 0.1)
    const t = this.clock.elapsedTime
    const vrm = this.vrm
    if (vrm) {
      const smooth = 1 - Math.exp(-dt * 8)
      const amount = this.motionAmount
      this.speakingLevel += (this.speakingTarget - this.speakingLevel) * smooth
      const talking = this.speakingLevel * amount
      this.mouth += (this.mouthTarget - this.mouth) * (1 - Math.exp(-dt * 22))
      if (this.mouthTarget === 0 && this.mouth < 0.01) this.mouth = 0
      vrm.expressionManager?.setValue('aa', this.mouth * 0.85)
      vrm.expressionManager?.setValue('ou', this.mouth * 0.15)
      for (const name of EMOTION_PRESETS) {
        const current = vrm.expressionManager?.getValue(name) || 0
        const target = name === this.emotion ? 0.45 : 0
        vrm.expressionManager?.setValue(name, current + (target - current) * smooth)
      }

      // Fully write the open-eye value as well, so blinks never get stuck.
      this.blinkTimer -= dt
      if (this.blinkTimer <= 0 && this.blinkElapsed < 0) {
        this.blinkElapsed = 0
        this.blinkTimer = 2.4 + Math.random() * 3.3
      }
      let blink = 0
      if (this.blinkElapsed >= 0) {
        this.blinkElapsed += dt
        const phase = this.blinkElapsed / 0.19
        blink = phase < 1 ? Math.sin(Math.PI * phase) : 0
        if (phase >= 1) this.blinkElapsed = -1
      }
      vrm.expressionManager?.setValue('blink', blink)

      // Breathing, asymmetric posture, small speech beats; feet stay planted.
      const breath = Math.sin(t * 1.65)
      const beat = Math.sin(t * 4.1) * Math.sin(t * 0.67)
      const pose = {
        hips: [0, 0, Math.sin(t * 0.57) * 0.012 * amount],
        spine: [(0.008 + breath * 0.009) * amount, Math.sin(t * 0.43) * 0.018 * amount, Math.sin(t * 0.57 + 0.5) * 0.008 * amount],
        chest: [breath * 0.008 * amount, 0, 0],
        neck: [0, Math.sin(t * 0.37) * 0.018 * amount, 0],
        head: [Math.sin(t * 0.71) * 0.018 * amount + beat * 0.025 * talking, Math.sin(t * 0.37 + 0.8) * 0.045 * amount, Math.sin(t * 0.49) * 0.025 * amount],
        leftUpperArm: [0.03 * amount, 0, -1.15 + breath * 0.012 * amount],
        rightUpperArm: [-0.02 * amount, 0, 1.15 - breath * 0.012 * amount - (0.05 + beat * 0.025) * talking],
        leftLowerArm: [0, 0, 0.07 * amount],
        rightLowerArm: [0, 0, -0.1 * amount - (0.06 + beat * 0.04) * talking],
        leftHand: [0, 0, 0.025 * amount],
        rightHand: [0, 0, -0.025 * amount],
      }
      if (this.motion) {
        const seconds = (performance.now() - this.motion.start) / 1000
        const duration = this.motion.duration / 1000
        if (seconds >= duration) this.motion = null
        else {
          const ramp = Math.min(1, seconds / 0.5, (duration - seconds) / 0.6)
          const weight = ramp * ramp * (3 - 2 * ramp) * Math.min(amount, 1)
          const add = (bone, x, y, z) => { pose[bone][0] += x * weight; pose[bone][1] += y * weight; pose[bone][2] += z * weight }
          if (this.motion.name === 'wave') {
            add('rightUpperArm', 0, 0.05, -1.15)
            add('rightLowerArm', 0, 0, -2.2 + Math.sin(seconds * 6) * 0.25)
            add('rightHand', 0, Math.sin(seconds * 6) * 0.25, Math.sin(seconds * 6) * 0.10)
            add('head', 0, 0, -0.04)
          } else if (this.motion.name === 'bow') {
            add('spine', 0.24, 0, 0); add('head', 0.1, 0, 0)
          } else if (this.motion.name === 'think') {
            add('head', 0.04, -0.08, 0.12)
            add('rightUpperArm', -0.15, 0, -0.22); add('rightLowerArm', 0, 0, -0.65)
          } else if (this.motion.name === 'cheer') {
            add('leftUpperArm', 0, 0, 0.45); add('rightUpperArm', 0, 0, -0.45)
            add('leftLowerArm', 0, 0, 0.7); add('rightLowerArm', 0, 0, -0.7)
          } else if (this.motion.name === 'shy') {
            add('head', 0.12, 0.08, 0.08); add('spine', 0.05, 0, 0)
          } else if (this.motion.name === 'clap') {
            // Restrained applause gesture; no root translation.
            add('leftUpperArm', -0.35, 0, 0.3); add('rightUpperArm', -0.35, 0, -0.3)
            add('leftLowerArm', -0.25, 0.3, 0.65); add('rightLowerArm', -0.25, -0.3, -0.65)
            add('leftHand', 0, 0.12 * Math.sin(seconds * 12), 0)
            add('rightHand', 0, -0.12 * Math.sin(seconds * 12), 0)
          }
        }
      }
      for (const [name, angles] of Object.entries(pose)) {
        const bone = this.bones[name]
        if (!bone) continue
        for (const [i, axis] of ['x', 'y', 'z'].entries()) bone.rotation[axis] += (angles[i] - bone.rotation[axis]) * smooth
      }
      if (t >= this.nextGaze) {
        this.gazeX = (Math.random() - 0.5) * 0.3
        this.gazeY = 1.35 + (Math.random() - 0.5) * 0.12
        this.nextGaze = t + 2.5 + Math.random() * 3
      }
      this.gaze.position.x += (this.gazeX * amount - this.gaze.position.x) * smooth
      this.gaze.position.y += (1.35 + (this.gazeY - 1.35) * amount - this.gaze.position.y) * smooth
      vrm.update(dt)
    }
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver?.disconnect()
    this.renderer?.dispose()
    this.container.innerHTML = ''
    this.container.style.display = 'none'
  }
}

window.VrmAvatar = VrmAvatar
