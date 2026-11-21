'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { classifyProcessName, normalizeDesktopSample, unknownDesktopContext,
  deriveDesktopPolicy, isUserReturning } = require('../src/core/desktop-context')
const { createWindowsDesktopContextReader, POWERSHELL_SCRIPT } = require('../src/core/windows-desktop-context')
const { DEFAULT_SETTINGS, loadSettings } = require('../src/core/config')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('デスクトップ状況連動は初期OFFで、旧設定にもOFFを補う', () => {
  assert.equal(DEFAULT_SETTINGS.desktopContext.enabled, false)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-desktop-config-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ autonomy:{ actionsEnabled:true } }))
  assert.equal(loadSettings(file).desktopContext.enabled, false)
})

test('前面アプリ名は端末内で大分類し、分類結果に詳細名を残さない', () => {
  assert.equal(classifyProcessName('Code.exe'), 'study_work')
  assert.equal(classifyProcessName('VALORANT-Win64-Shipping.exe'), 'game')
  assert.equal(classifyProcessName('Discord.exe'), 'communication')
  assert.equal(classifyProcessName('custom-private-app.exe'), 'other')
  assert.equal(classifyProcessName(''), 'unknown')
  const context = normalizeDesktopSample({ idleMs:1234, processName:'PrivateApp.exe', fullscreen:true })
  assert.deepEqual(context, { available:true, idleMs:1234, foregroundCategory:'other', fullscreenApp:true })
  assert.equal(Object.hasOwn(context, 'processName'), false)
})

test('仕事・ゲーム・全画面は独り言を抑え、長時間無操作はAPIと動作を止める', () => {
  assert.equal(deriveDesktopPolicy(normalizeDesktopSample({ idleMs:1000, processName:'Code' })).suppressSpeech, true)
  const game = deriveDesktopPolicy(normalizeDesktopSample({ idleMs:1000, processName:'VALORANT', fullscreen:false }))
  assert.equal(game.suppressSpeech, true)
  assert.equal(game.preferredAction, 'nod')
  assert.equal(deriveDesktopPolicy(normalizeDesktopSample({ idleMs:1000, fullscreen:true })).suppressSpeech, true)
  assert.equal(deriveDesktopPolicy({ ...unknownDesktopContext(), ownWindowState:{ visible:false, minimized:false } }).suppressSpeech, true)
  assert.equal(deriveDesktopPolicy({ ...unknownDesktopContext(), ownWindowState:{ visible:true, minimized:true } }).suppressActions, true)
  const longIdle = deriveDesktopPolicy(normalizeDesktopSample({ idleMs:30*60*1000, processName:'other' }))
  assert.equal(longIdle.suppressSpeech, true)
  assert.equal(longIdle.suppressActions, true)
  assert.equal(deriveDesktopPolicy(unknownDesktopContext()).suppressSpeech, false)
})

test('ユーザー復帰は長い無操作から短時間へ戻った遷移だけ検出する', () => {
  assert.equal(isUserReturning(5*60*1000, 30*1000), true)
  assert.equal(isUserReturning(299999, 1000), false)
  assert.equal(isUserReturning(600000, 30001), false)
  assert.equal(isUserReturning(null, 0), false)
})

test('Windows取得が未対応・拒否・失敗なら例外を外へ出さずunknownを返す', async () => {
  const unsupported = await createWindowsDesktopContextReader({ platform:'linux' })()
  assert.deepEqual(unsupported, unknownDesktopContext())
  const denied = await createWindowsDesktopContextReader({ platform:'win32', execFileImpl(_file, _args, _opts, callback) {
    const error = new Error('Access denied'); error.code = 'EACCES'; callback(error)
  } })()
  assert.deepEqual(denied, unknownDesktopContext())
  const malformed = await createWindowsDesktopContextReader({ platform:'win32', execFileImpl(_file, _args, _opts, callback) {
    callback(null, { stdout:'not json' }, '')
  } })()
  assert.deepEqual(malformed, unknownDesktopContext())
  assert.ok(!POWERSHELL_SCRIPT.includes('GetWindowText'))
  assert.ok(!POWERSHELL_SCRIPT.includes('GetClipboard'))
  assert.ok(!POWERSHELL_SCRIPT.includes('SetCursor') && !POWERSHELL_SCRIPT.includes('SendInput'))
})
