'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FollowUpScheduler, candidateDueAt, followUpText, isQuietTime } = require('../src/core/proactive-followups')
const { DEFAULT_SETTINGS } = require('../src/core/config')
const { AutonomyGuard } = require('../src/core/autonomy')

function fixture(start = new Date(2026, 2, 10, 12, 0).getTime()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-follow-up-'))
  let now = start
  const filePath = path.join(dir, 'proactive-followups.json')
  const make = () => {
    const scheduler = new FollowUpScheduler(filePath, { now:() => now })
    scheduler.startedAt = now - 6 * 60_000
    return scheduler
  }
  return { dir, filePath, scheduler:make(), make, get now() { return now }, set now(value) { now = value }, close:() => fs.rmSync(dir, { recursive:true, force:true }) }
}

function item(overrides = {}) {
  const createdAt = new Date(2026, 2, 1, 12).toISOString()
  return { id:'memory-1', type:'open_loop', content:'電磁気学の試験準備', status:'active', sensitive:false,
    createdAt, updatedAt:createdAt, expiresAt:new Date(2026, 2, 9, 12).toISOString(), ...overrides }
}

function eligibleOptions(now, overrides = {}) {
  return { now, config:{ followUpsEnabled:true, dailyMax:2, quietHours:{ enabled:false } }, idleForMs:11 * 60_000,
    busy:false, focusMode:false, fullscreen:false, windowAvailable:true, ...overrides }
}

test('初期値はOFF、吹き出しを標準にし、ローカル判断は追加APIを要求しない', () => {
  assert.deepEqual(DEFAULT_SETTINGS.proactive, { followUpsEnabled:false, delivery:'bubble',
    quietHours:{ enabled:true, start:'22:00', end:'08:00' }, dailyMax:2 })
  assert.match(followUpText(item()), /電磁気学の試験準備/u)
})

test('候補は有効なOpen LoopとCommitmentだけで、完了・期限切れ・個人情報は除外する', () => {
  const f = fixture()
  try {
    const good = item()
    const candidates = [
      { ...good, id:'fact', type:'user_fact' }, { ...good, id:'pref', type:'preference' },
      { ...good, id:'complete', status:'completed' }, { ...good, id:'cancel', status:'cancelled' },
      { ...good, id:'expired', expiresAt:new Date(f.now - 15 * 86400_000).toISOString() },
      { ...good, id:'sensitive', sensitive:true }, good,
      { ...good, id:'commitment', type:'commitment', status:'planned' },
    ]
    const selected = f.scheduler.selectCandidate(candidates, eligibleOptions(f.now))
    assert.ok(['memory-1','commitment'].includes(selected.item.id))
    assert.equal(f.scheduler.selectCandidate(candidates.slice(0, 6), eligibleOptions(f.now)), null)
  } finally { f.close() }
})

test('日付がある話題は翌日のローカル朝、日付不明なら作成7日後のローカル朝に候補化', () => {
  const dated = item({ expiresAt:new Date(2026, 2, 9, 18, 45).toISOString() })
  const expectedDated = new Date(2026, 2, 10, 9, 0).getTime()
  assert.equal(candidateDueAt(dated), expectedDated)
  const undated = item({ expiresAt:null, createdAt:new Date(2026, 2, 1, 13, 30).toISOString() })
  assert.equal(candidateDueAt(undated), new Date(2026, 2, 8, 9, 0).getTime())
  assert.equal(candidateDueAt(item({ createdAt:'invalid', expiresAt:null })), Infinity)
})

test('ユーザー指定の延期時刻は古い元期限より優先される', () => {
  const f = fixture()
  try {
    const reminder = f.now + 200 * 86400_000
    const deferred = item({ expiresAt:new Date(f.now - 30 * 86400_000).toISOString(),
      followUpAt:new Date(reminder).toISOString(), status:'postponed' })
    assert.equal(f.scheduler.selectCandidate([deferred], eligibleOptions(f.now)), null)
    assert.ok(f.scheduler.selectCandidate([deferred], eligibleOptions(reminder)))
  } finally { f.close() }
})

test('静音時間は日付またぎと同一時刻を安全に処理する', () => {
  assert.equal(isQuietTime(new Date(2026, 2, 10, 23, 0), { enabled:true, start:'22:00', end:'08:00' }), true)
  assert.equal(isQuietTime(new Date(2026, 2, 10, 7, 59), { enabled:true, start:'22:00', end:'08:00' }), true)
  assert.equal(isQuietTime(new Date(2026, 2, 10, 12, 0), { enabled:true, start:'22:00', end:'08:00' }), false)
  assert.equal(isQuietTime(new Date(2026, 2, 10, 12, 0), { enabled:true, start:'12:00', end:'12:00' }), true)
  assert.equal(isQuietTime(new Date(2026, 2, 10, 23, 0), { enabled:false }), false)
})

test('起動直後、会話中、集中モード、全画面、利用不能、無操作不足は抑制する', () => {
  const f = fixture()
  try {
    const candidate = item()
    f.scheduler.startedAt = f.now
    for (const options of [
      eligibleOptions(f.now), eligibleOptions(f.now + 6 * 60_000, { busy:true }),
      eligibleOptions(f.now + 6 * 60_000, { focusMode:true }), eligibleOptions(f.now + 6 * 60_000, { fullscreen:true }),
      eligibleOptions(f.now + 6 * 60_000, { windowAvailable:false }), eligibleOptions(f.now + 6 * 60_000, { idleForMs:1 }),
      eligibleOptions(f.now + 6 * 60_000, { config:{ followUpsEnabled:false, quietHours:{ enabled:false } } }),
      eligibleOptions(f.now + 6 * 60_000, { config:{ followUpsEnabled:true, quietHours:{ enabled:true, start:'00:00', end:'23:59' } } }),
    ]) assert.equal(f.scheduler.selectCandidate([candidate], options), null)
  } finally { f.close() }
})

test('明示許可されたデスクトップ状況では仕事・ゲーム・全画面・不明を抑制する', () => {
  const f = fixture()
  try {
    const candidate = item()
    for (const desktopContext of [
      { available:false, foregroundCategory:'unknown' },
      { available:true, foregroundCategory:'study_work', fullscreenApp:false, idleMs:0 },
      { available:true, foregroundCategory:'game', fullscreenApp:false, idleMs:0 },
      { available:true, foregroundCategory:'other', fullscreenApp:true, idleMs:0 },
      { available:true, foregroundCategory:'other', fullscreenApp:false, idleMs:31 * 60_000 },
    ]) assert.equal(f.scheduler.selectCandidate([candidate], eligibleOptions(f.now + 6 * 60_000,
      { desktopContextEnabled:true, desktopContext })), null)
    assert.ok(f.scheduler.selectCandidate([candidate], eligibleOptions(f.now + 6 * 60_000,
      { desktopContextEnabled:false, desktopContext:{ available:false } })))
  } finally { f.close() }
})

test('一起動一件・一日最大二件・同一話題24時間と無応答再通知7日を守る', () => {
  const f = fixture()
  try {
    const first = item()
    const second = item({ id:'memory-2', content:'レポート提出', expiresAt:new Date(2026, 2, 9, 12).toISOString() })
    const opts = eligibleOptions(f.now)
    assert.ok(f.scheduler.selectCandidate([first, second], opts))
    assert.equal(f.scheduler.recordDelivery(first, 'bubble', f.now), true)
    assert.equal(f.scheduler.selectCandidate([second], opts), null)
    const restarted = f.make()
    assert.ok(restarted.selectCandidate([second], opts))
    assert.equal(restarted.recordDelivery(second, 'bubble', f.now), true)
    const anotherRestart = f.make()
    assert.equal(anotherRestart.selectCandidate([first, second], opts), null)
    f.now += 2 * 86400_000
    assert.equal(anotherRestart.selectCandidate([first], eligibleOptions(f.now)), null)
    f.now += 6 * 86400_000
    assert.ok(anotherRestart.selectCandidate([first], eligibleOptions(f.now)))
  } finally { f.close() }
})

test('日次上限は古い保存済み現地日付に頼らず通知時刻から再計算する', () => {
  const f = fixture()
  try {
    const first = item()
    const second = item({ id:'memory-2', content:'提出するレポート' })
    const options = eligibleOptions(f.now, { config:{ followUpsEnabled:true, dailyMax:1, quietHours:{ enabled:false } } })
    f.scheduler.recordDelivery(first, 'bubble', f.now)
    f.scheduler.events[0].dayKey = '1900-01-01'
    f.scheduler.presentedThisLaunch.clear()
    assert.equal(f.scheduler.selectCandidate([second], options), null)
  } finally { f.close() }
})

test('返答は明示完了のみ完了扱いにし、延期・継続・通知停止を保持する', () => {
  const f = fixture()
  try {
    const first = item()
    f.scheduler.recordDelivery(first, 'bubble', f.now)
    assert.equal(f.scheduler.respond(first, 'working', { now:f.now }), true)
    assert.equal(f.scheduler.hasPending(first), false)
    assert.equal(f.scheduler.events[0].response, 'working')
    assert.equal(f.scheduler.events[0].nextAt, f.now + 7 * 86400_000)
    assert.equal(f.scheduler.respond(first, 'completed', { now:f.now }), false)

    const later = item({ id:'memory-later', content:'課題の進み具合' })
    const laterScheduler = f.make()
    laterScheduler.recordDelivery(later, 'bubble', f.now)
    const nextAt = f.now + 3 * 60 * 60_000
    assert.equal(laterScheduler.respond(later, 'later', { now:f.now, nextAt }), true)
    assert.equal(laterScheduler.events.at(-1).nextAt, nextAt)

    const shortFixture = fixture()
    try {
      const shortTopic = item({ id:'short-reminder', content:'明日確認する課題' })
      shortFixture.scheduler.recordDelivery(shortTopic, 'bubble', shortFixture.now)
      const shortNextAt = shortFixture.now + 3 * 60 * 60_000
      assert.equal(shortFixture.scheduler.respond(shortTopic, 'later', { now:shortFixture.now, nextAt:shortNextAt }), true)
      const restoredShortReminder = shortFixture.make()
      assert.equal(restoredShortReminder.selectCandidate([shortTopic], eligibleOptions(shortNextAt - 1)), null)
      assert.ok(restoredShortReminder.selectCandidate([shortTopic], eligibleOptions(shortNextAt)))
    } finally { shortFixture.close() }

    const muted = item({ id:'memory-muted', content:'もう聞かない話題' })
    const muteScheduler = f.make()
    muteScheduler.recordDelivery(muted, 'bubble', f.now)
    assert.equal(muteScheduler.respond(muted, 'mute', { now:f.now }), true)
    assert.equal(muteScheduler.isMuted(muted), true)
    assert.equal(muteScheduler.selectCandidate([muted], eligibleOptions(f.now + 6 * 60_000)), null)
  } finally { f.close() }
})

test('通知回数・通知停止・クールダウンは再起動後に復元され、保存データに話題本文を含めない', () => {
  const f = fixture()
  try {
    const first = item()
    f.scheduler.recordDelivery(first, 'bubble', f.now)
    const parsed = JSON.parse(fs.readFileSync(f.filePath, 'utf8'))
    parsed.events[0].dayKey = '1900-01-01'
    fs.writeFileSync(f.filePath, JSON.stringify(parsed))
    f.scheduler.setMuted(item({ id:'mute-me', content:'機微な予定の本文は保存しない' }), true)
    const raw = fs.readFileSync(f.filePath, 'utf8')
    assert.doesNotMatch(raw, /電磁気学|機微な予定/u)
    const restored = f.make()
    assert.equal(restored.status([first, item({ id:'mute-me', content:'機微な予定の本文は保存しない' })]).todayCount, 1)
    assert.equal(restored.isMuted(item({ id:'mute-me', content:'機微な予定の本文は保存しない' })), true)
    assert.equal(restored.selectCandidate([first], eligibleOptions(f.now)), null)
  } finally { f.close() }
})

test('記憶を全削除すると通知履歴と通知停止も一緒に消す', () => {
  const f = fixture()
  try {
    const first = item()
    f.scheduler.recordDelivery(first, 'bubble', f.now)
    f.scheduler.setMuted(item({ id:'mute-me', content:'通知停止対象' }), true)
    f.scheduler.clear()
    const restored = f.make()
    assert.equal(restored.status().todayCount, 0)
    assert.equal(restored.isMuted(item({ id:'mute-me', content:'通知停止対象' })), false)
  } finally { f.close() }
})

test('状態ファイルが壊れているとき元データを保護し、通知を出さない', () => {
  const f = fixture()
  try {
    fs.writeFileSync(f.filePath, '{broken')
    const scheduler = f.make()
    assert.equal(scheduler.status().writable, false)
    assert.equal(scheduler.selectCandidate([item()], eligibleOptions(f.now)), null)
    assert.throws(() => scheduler.recordDelivery(item(), 'bubble', f.now), /元ファイルを保護/u)
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), '{broken')
  } finally { f.close() }
})

test('Phase 4の5分クールダウン・時間3回上限にフォローアップの保守上限を重ねる', () => {
  const guard = new AutonomyGuard()
  const now = new Date(2026, 2, 10, 12).getTime()
  assert.equal(guard.beginSpeech(now), true)
  guard.finishSpeech()
  assert.equal(guard.canSpeak({ enabled:true, voiceEnabled:true, idleForMs:600_000, idleThresholdMs:600_000, now:now + 60_000 }), false)
})
