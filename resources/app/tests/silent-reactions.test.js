'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Limiter } = require('../src/core/silent-reactions')
const { DEFAULT_SETTINGS } = require('../src/core/config')
const { allowsSilentReaction } = require('../src/core/desktop-context')

test('無言リアクションは既定OFF', () => assert.equal(DEFAULT_SETTINGS.features.silentReactions, false))
test('吹き出しは30秒の間隔と1時間3回の上限を守る', () => {
  const limit = new Limiter()
  assert.equal(limit.allow('thinking', 1000, limit.ticket()), true)
  assert.equal(limit.allow('thinking', 30999, limit.ticket()), false)
  assert.equal(limit.allow('proud', 31000, limit.ticket()), true)
  assert.equal(limit.allow('surprised', 61000, limit.ticket()), true)
  assert.equal(limit.allow('thinking', 91000, limit.ticket()), false)
  assert.equal(limit.allow('thinking', 3601000, limit.ticket()), true)
})
test('中断済みの非同期応答と未知の吹き出しは表示しない', () => {
  const limit = new Limiter()
  const stale = limit.ticket()
  limit.invalidate()
  assert.equal(limit.allow('thinking', 1000, stale), false)
  assert.equal(limit.allow('other', 1000, limit.ticket()), false)
  assert.equal(limit.allow('confused', 1000, limit.ticket()), true)
})
test('集中・勉強・ゲーム・全画面・未取得を抑制し、連動OFFでは情報を要求しない', () => {
  const opts = { enabled:true, focusMode:false, desktopEnabled:true }
  const context = { available:true, foregroundCategory:'other', fullscreenApp:false, idleMs:100 }
  assert.equal(allowsSilentReaction(opts, context), true)
  for (const patch of [{ foregroundCategory:'study_work' }, { foregroundCategory:'game' }, { fullscreenApp:true }, { available:false }, { fullscreenApp:null }]) {
    assert.equal(allowsSilentReaction(opts, { ...context, ...patch }), false)
  }
  assert.equal(allowsSilentReaction({ ...opts, focusMode:true }, context), false)
  assert.equal(allowsSilentReaction({ ...opts, desktopEnabled:false }, null), true)
  assert.equal(allowsSilentReaction({ ...opts, enabled:false }, context), false)
})
