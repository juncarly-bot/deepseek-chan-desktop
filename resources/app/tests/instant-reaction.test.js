'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Controller } = require('../src/core/instant-reaction')
const { DEFAULT_SETTINGS } = require('../src/core/config')

function harness(random = () => 0) {
  const states = [], tasks = new Map()
  let next = 0
  const controller = new Controller({ setState: state => states.push(state), random,
    schedule: (fn, ms) => { const id = ++next; tasks.set(id, { fn, ms }); return id },
    cancel: id => tasks.delete(id) })
  return { controller, states, tasks }
}

test('即時リアクションは初期OFF', () => assert.equal(DEFAULT_SETTINGS.features.instantReaction, false))
test('入力直後に傾聴し、遅い応答には思考姿勢へ移る', () => {
  const { controller, states, tasks } = harness(() => 0.5)
  controller.begin()
  assert.deepEqual(states, ['listening'])
  const task = [...tasks.values()][0]
  assert.equal(task.ms, 500)
  controller.transition('thinking')
  assert.deepEqual(states, ['listening'])
  task.fn()
  assert.deepEqual(states, ['listening', 'thinking'])
})
test('新しい入力や発話後、古いタイマーは姿勢を上書きしない', () => {
  const { controller, states, tasks } = harness()
  const first = controller.begin()
  const stale = [...tasks.values()][0].fn
  const second = controller.begin()
  assert.equal(controller.current(first), false)
  assert.equal(controller.current(second), true)
  stale()
  controller.transition('speaking')
  for (const task of tasks.values()) task.fn()
  assert.equal(states.at(-1), 'speaking')
  assert.equal(tasks.size, 0)
  controller.invalidate()
  assert.equal(states.at(-1), 'idle')
})
