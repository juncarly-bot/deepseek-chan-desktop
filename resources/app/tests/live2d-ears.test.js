'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('耳の動きは初期位置から滑らかに追従し、左右別に元へ戻る', () => {
  const context = { window: {}, performance: { now: () => 0 } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/avatar-live2d.js'), 'utf8'), context)
  const avatar = new context.window.Live2DAvatar({})
  const raw = Object.fromEntries(['LEar1','LEar2','LEar3','REar1','REar2','REar3'].map(k => [k, 0]))
  const output = {}
  const core = { getParameterValueById: id => raw[id], setParameterValueById: (id, value) => { output[id] = value } }
  avatar.smoothEarMotion(core, 1 / 60)
  raw.LEar1 = 1
  avatar.smoothEarMotion(core, 1 / 60)
  assert.ok(output.LEar1 > 0 && output.LEar1 < 0.2)
  assert.equal(output.REar1, 0)
  for (let i = 0; i < 60; i++) avatar.smoothEarMotion(core, 1 / 60)
  assert.ok(output.LEar1 > 0.99)
  raw.LEar1 = 0
  avatar.smoothEarMotion(core, 1 / 60)
  assert.ok(output.LEar1 > 0 && output.LEar1 < 1)
})
