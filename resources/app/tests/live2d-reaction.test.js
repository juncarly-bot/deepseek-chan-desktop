'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('表情の変化に合わせた動きは徐々に始まり、元の姿勢に戻る', () => {
  let now = 1000
  const context = { window: {}, performance: { now: () => now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  avatar.setEmotion('surprised', 1)
  assert.equal(avatar.getEmotionReaction(now).headY, 0)
  now += 800
  const surprise = avatar.getEmotionReaction(now)
  assert.ok(surprise.headY > 4 && surprise.bodyY > 2)
  now += 900
  assert.equal(avatar.getEmotionReaction(now).headY, 0)
  avatar.setEmotion('sad', 1)
  now += 800
  assert.ok(avatar.getEmotionReaction(now).headY < 0)
  avatar.setEmotion('neutral')
  assert.equal(avatar.getEmotionReaction(now).headY, 0)
})

test('15感情と旧感情名が安全に姿勢へ変換される', () => {
  let now = 1000
  const context = { window: {}, performance: { now: () => now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  for (const emotion of ['neutral', 'happy', 'shy', 'excited', 'thinking', 'sleepy', 'proud', 'sad', 'annoyed', 'surprised', 'greeting', 'playful', 'flustered', 'confused', 'pout', 'angry', 'relaxed', 'worried', 'loving', 'crying', 'unregistered']) {
    avatar.setEmotion(emotion, 0.8)
    now += 800
    const motion = avatar.getEmotionReaction(now)
    assert.ok(Number.isFinite(motion.headY) && Number.isFinite(motion.headZ))
  }
  avatar.setEmotion('neutral')
  assert.equal(avatar.getEmotionReaction(now).headY, 0)
})

test('待機・傾聴・思考・発話・反応の状態を安全に切り替えられる', () => {
  let now = 1000
  const context = { window: {}, performance: { now: () => now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'reacting']) {
    avatar.setState(state)
    assert.equal(avatar.state, state)
  }
  avatar.setState('unknown')
  assert.equal(avatar.state, 'reacting')
  avatar.playMotion('nod')
  now += 210
  assert.ok(avatar.getNodWeight(now) > 0.9)
  avatar.nod.strength = 0.4
  assert.ok(Math.abs(avatar.getNodWeight(now) - 0.4) < 0.001)
  now += 220
  assert.equal(avatar.getNodWeight(now), 0)
})

test('追加待機モーションは既定OFFで、ON時だけ小さな動作を行い、待機外で停止する', () => {
  let now = 1000
  const context = { window: {}, performance: { now: () => now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  avatar.random = () => 0
  assert.equal(avatar.naturalIdleEnabled, false)
  assert.deepEqual({ ...avatar.getIdleGestureOffsets(100) },
    { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 })

  avatar.setNaturalIdleEnabled(true)
  assert.deepEqual({ ...avatar.getIdleGestureOffsets(18) },
    { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 })
  avatar.getIdleGestureOffsets(19)
  const moving = avatar.getIdleGestureOffsets(20.2)
  assert.ok(moving.headY > 0 && moving.bodyY > 0)
  assert.ok(Math.abs(moving.headY) <= 1.8 && Math.abs(moving.headZ) <= 2)

  now = 20200
  avatar.setState('speaking')
  assert.ok(avatar.getIdleGestureOffsets(20.2).headY > 0)
  now = 20250
  avatar.setState('idle')
  assert.ok(avatar.getIdleGestureOffsets(20.25).headY > 0)
  assert.deepEqual({ ...avatar.getIdleGestureOffsets(20.6) },
    { headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0 })
  avatar.setNaturalIdleEnabled(false)
  assert.equal(avatar.nextIdleGestureAt, null)
})

test('感情余韻は既定OFFで従来動作を保ち、ON時は保持後に滑らかに減衰する', () => {
  let now = 1000
  const context = { window: {}, performance: { now: () => now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  avatar.setEmotion('happy', 0.8)
  assert.equal(avatar.emotionPersistenceEnabled, false)
  avatar.releaseEmotion()
  assert.equal(avatar.emotion, 'neutral')

  avatar.setEmotionPersistenceEnabled(true)
  avatar.setEmotion('happy', 0.8, 'conversation')
  now += 5000
  assert.equal(avatar.getEmotionRenderIntensity(now), 0.8, 'emotion is held until speech ends')
  const speechEndedAt = now
  avatar.releaseEmotion(speechEndedAt)
  assert.equal(avatar.emotionSource, 'conversation')
  assert.equal(avatar.emotionHeldUntil, speechEndedAt)
  assert.ok(Math.abs(avatar.getEmotionRenderIntensity(speechEndedAt + 1100) - 0.2) < 0.001)
  assert.equal(avatar.emotion, 'happy')
  assert.equal(avatar.getEmotionRenderIntensity(speechEndedAt + 2201), 0)
  assert.equal(avatar.emotion, 'neutral')
  assert.equal(avatar.emotionSource, 'decay')
})

test('感情の急な切り替えは減衰を解除し、未知IDはneutralへ戻す', () => {
  let now = 2000
  const context = { window: {}, performance: { now: () => now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  avatar.setEmotionPersistenceEnabled(true)
  avatar.setEmotion('sad', 0.9)
  avatar.releaseEmotion(now)
  now += 400
  avatar.setEmotion('excited', 0.65)
  assert.equal(avatar.emotion, 'excited')
  assert.equal(avatar.emotionDecayStartedAt, null)
  assert.equal(avatar.emotionChangedAt, now)
  assert.equal(avatar.getEmotionRenderIntensity(now + 5000), 0.65)
  avatar.setEmotion('not-a-real-emotion', 1)
  assert.equal(avatar.emotion, 'neutral')
})
