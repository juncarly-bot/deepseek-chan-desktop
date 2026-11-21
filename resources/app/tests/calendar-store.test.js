'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CalendarStore, CATEGORIES, dateKeyInZone, zonedDateTimeToIso } = require('../src/core/calendar-store')

function fixture(now = Date.parse('2026-03-09T03:00:00.000Z')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-calendar-'))
  let clock = now
  const file = path.join(dir, 'calendar.json')
  const create = () => new CalendarStore(file, { now:() => clock })
  return { dir, file, store:create(), create, get now() { return clock }, set now(value) { clock = value }, close:() => fs.rmSync(dir, { recursive:true, force:true }) }
}

function timed(title, category, startAt, endAt, extra = {}) {
  return { title, category, startAt, endAt, timeZone:'Asia/Tokyo', memo:'', notify:false, ...extra }
}

test('予定の追加・編集・削除と必須値・秘密情報の検証', () => {
  const f = fixture()
  try {
    assert.deepEqual(CATEGORIES, ['lesson','exam','assignment','study','personal','other'])
    const added = f.store.add(timed('電磁気学の試験', 'exam', '2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z'))
    assert.equal(added.duplicate, false)
    assert.equal(f.store.update(added.item.id, { title:'電磁気学 中間試験' }).title, '電磁気学 中間試験')
    assert.equal(f.store.delete(added.item.id), true)
    assert.equal(f.store.delete(added.item.id), false)
    assert.throws(() => f.store.add(timed('', 'exam', '2026-03-10T01:00:00Z')), /予定名/u)
    assert.throws(() => f.store.add(timed('API key: sk-abcdefghijklmnop', 'other', '2026-03-10T01:00:00Z')), /秘密情報/u)
    assert.throws(() => f.store.add(timed('token ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'other', '2026-03-10T01:00:00Z')), /秘密情報/u)
    assert.throws(() => f.store.add(timed('無効な種類', 'unknown', '2026-03-10T01:00:00Z')), /種類/u)
  } finally { f.close() }
})

test('同じ予定の重複登録を拒み、異なる時刻は別の予定として保持する', () => {
  const f = fixture()
  try {
    const base = timed('力学', 'lesson', '2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z')
    const first = f.store.add(base)
    const duplicate = f.store.add(base)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.item.id, first.item.id)
    const second = f.store.add({ ...base, startAt:'2026-03-11T01:00:00Z', endAt:'2026-03-11T02:00:00Z' }).item
    assert.throws(() => f.store.update(second.id, { startAt:first.item.startAt, endAt:first.item.endAt,
      startDate:first.item.startDate, endDate:first.item.endDate }), /同じ予定/u)
  } finally { f.close() }
})

test('毎週繰り返す授業はローカル時刻を保ち、個別休講と一回だけの編集に対応する', () => {
  const f = fixture()
  try {
    const series = f.store.add({ ...timed('物理学実験', 'lesson', zonedDateTimeToIso('2026-03-04','13:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-04','14:30','Asia/Tokyo')),
      recurrence:{ frequency:'weekly', weekdays:[3], startDate:'2026-03-04', endDate:'2026-04-29', startTime:'13:00', endTime:'14:30' } }).item
    const before = f.store.occurrencesForDate('2026-03-11').find(row => row.parentId === series.id)
    assert.ok(before)
    assert.equal(dateKeyInZone(before.startAt, 'Asia/Tokyo'), '2026-03-11')
    assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Tokyo', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(before.startAt)), '13:00')
    assert.equal(f.store.deleteOccurrence(before.occurrenceId), true)
    assert.equal(f.store.occurrencesForDate('2026-03-11').some(row => row.parentId === series.id), false)
    const next = f.store.occurrencesForDate('2026-03-18').find(row => row.parentId === series.id)
    const changed = f.store.updateOccurrence(next.occurrenceId, { title:'休講振替・物理学実験' })
    assert.equal(changed.title, '休講振替・物理学実験')
    assert.equal(f.store.occurrencesForDate('2026-03-18').find(row => row.occurrenceId === next.occurrenceId).title, '休講振替・物理学実験')
    assert.equal(f.store.get(series.id).title, '物理学実験')
  } finally { f.close() }
})

test('繰り返し全体の編集と削除は個別例外を保ったうえで適用する', () => {
  const f = fixture()
  try {
    const event = f.store.add({ ...timed('数学演習', 'lesson', zonedDateTimeToIso('2026-03-02','10:20','Asia/Tokyo'), zonedDateTimeToIso('2026-03-02','11:50','Asia/Tokyo')),
      recurrence:{ frequency:'weekly', weekdays:[1], startDate:'2026-03-02', endDate:'2026-03-30', startTime:'10:20', endTime:'11:50' } }).item
    const edited = f.store.occurrencesForDate('2026-03-09').find(row => row.parentId === event.id)
    f.store.updateOccurrence(edited.occurrenceId, { memo:'第2教室' })
    const series = f.store.update(event.id, { title:'数学演習A' })
    assert.equal(series.title, '数学演習A')
    assert.equal(f.store.occurrencesForDate('2026-03-09').find(row => row.occurrenceId === edited.occurrenceId).memo, '第2教室')
    assert.equal(f.store.delete(event.id), true)
    assert.equal(f.store.occurrencesForDate('2026-03-09').some(row => row.parentId === event.id), false)
  } finally { f.close() }
})

test('繰り返し期間を縮めたとき範囲外の例外を安全に整理して再読込できる', () => {
  const f = fixture()
  try {
    const item = f.store.add({ ...timed('解析学', 'lesson', zonedDateTimeToIso('2026-03-02','10:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-02','11:00','Asia/Tokyo')),
      recurrence:{ frequency:'weekly', weekdays:[1], startDate:'2026-03-02', endDate:'2026-04-27', startTime:'10:00', endTime:'11:00' } }).item
    const occurrence = f.store.occurrencesForDate('2026-03-16').find(row => row.parentId === item.id)
    f.store.updateOccurrence(occurrence.occurrenceId, { title:'振替講義' })
    const revised = f.store.update(item.id, { recurrence:{ ...item.recurrence, endDate:'2026-03-09' } })
    assert.deepEqual(Object.keys(revised.exceptions), [])
    const restarted = f.create(); restarted.load()
    assert.equal(restarted.status().writable, true)
    assert.equal(restarted.occurrencesForDate('2026-03-16').some(row => row.parentId === item.id), false)
  } finally { f.close() }
})

test('存在しない繰り返し回の指定を拒み、保存ファイルを壊さない', () => {
  const f = fixture()
  try {
    const item = f.store.add({ ...timed('統計力学', 'lesson', zonedDateTimeToIso('2026-03-02','10:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-02','11:00','Asia/Tokyo')),
      recurrence:{ frequency:'weekly', weekdays:[1], startDate:'2026-03-02', endDate:'2026-03-30', startTime:'10:00', endTime:'11:00' } }).item
    assert.equal(f.store.deleteOccurrence(`${item.id}::2026-03-03`), false)
    assert.equal(f.store.updateOccurrence(`${item.id}::2026-04-06`, { title:'無効' }), null)
    const restarted = f.create(); restarted.load()
    assert.equal(restarted.status().writable, true)
    assert.deepEqual(restarted.get(item.id).exceptions, {})
  } finally { f.close() }
})

test('終日予定と締切課題を日付選択で見つけ、完了状態を識別する', () => {
  const f = fixture()
  try {
    const allDay = f.store.add({ title:'春休み', category:'personal', allDay:true, startDate:'2026-03-10', endDate:'2026-03-11', timeZone:'Asia/Tokyo' }).item
    assert.equal(f.store.occurrencesForDate('2026-03-10').some(row => row.id === allDay.id), true)
    assert.equal(f.store.occurrencesForDate('2026-03-11').some(row => row.id === allDay.id), true)
    const task = f.store.add({ title:'電磁気学レポート', category:'assignment', deadlineAt:zonedDateTimeToIso('2026-03-12','23:59','Asia/Tokyo'), taskStatus:'not_started' }).item
    assert.equal(task.taskStatus, 'not_started')
    const completed = f.store.update(task.id, { taskStatus:'completed' })
    assert.equal(completed.completed, true)
    assert.equal(f.store.summary(f.now).unfinishedAssignments.some(row => row.id === task.id), false)
  } finally { f.close() }
})

test('日をまたぐ予定は両日を跨ぐ検索期間に正しく含まれる', () => {
  const f = fixture()
  try {
    const night = f.store.add(timed('夜間実験', 'other', zonedDateTimeToIso('2026-03-09','23:30','Asia/Tokyo'), zonedDateTimeToIso('2026-03-10','01:00','Asia/Tokyo'))).item
    assert.ok(f.store.occurrencesForDate('2026-03-09').some(row => row.id === night.id))
    assert.ok(f.store.occurrencesForDate('2026-03-10').some(row => row.id === night.id))
  } finally { f.close() }
})

test('終日予定も現在進行中としてローカル要約へ含める', () => {
  const f = fixture(Date.parse('2026-03-10T03:30:00.000Z'))
  try {
    f.store.add({ title:'学会日', category:'personal', allDay:true, startDate:'2026-03-10', endDate:'2026-03-10', timeZone:'Asia/Tokyo' })
    assert.equal(f.store.summary(f.now).current?.title, '学会日')
  } finally { f.close() }
})

test('期限切れの未完了課題は課題一覧に残し、近日の締切一覧から除く', () => {
  const f = fixture(Date.parse('2026-03-10T03:30:00.000Z'))
  try {
    const overdue = f.store.add({ title:'期限超過課題', category:'assignment', deadlineAt:zonedDateTimeToIso('2026-03-09','23:59','Asia/Tokyo'), taskStatus:'in_progress' }).item
    f.store.add(timed('先の試験', 'exam', zonedDateTimeToIso('2026-06-01','09:00','Asia/Tokyo'), zonedDateTimeToIso('2026-06-01','10:00','Asia/Tokyo')))
    const summary = f.store.summary(f.now)
    assert.ok(summary.unfinishedAssignments.some(row => row.id === overdue.id))
    assert.equal(summary.upcomingAssignments.some(row => row.id === overdue.id), false)
    assert.ok(summary.exams.some(row => row.title === '先の試験'))
  } finally { f.close() }
})

test('DST変更後も週次予定の現地時刻を維持し、存在しない時刻は拒否する', () => {
  const before = zonedDateTimeToIso('2026-03-02','10:20','America/New_York')
  const after = zonedDateTimeToIso('2026-03-09','10:20','America/New_York')
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(before)), '10:20')
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(after)), '10:20')
  assert.throws(() => zonedDateTimeToIso('2026-03-08','02:30','America/New_York'), /存在しません/u)
})

test('今週・次の授業・締切・試験・進行中予定のローカル要約を返す', () => {
  const f = fixture(Date.parse('2026-03-10T03:30:00.000Z'))
  try {
    f.store.add(timed('講義', 'lesson', zonedDateTimeToIso('2026-03-10','12:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-10','13:00','Asia/Tokyo')))
    f.store.add(timed('次の授業', 'lesson', zonedDateTimeToIso('2026-03-12','09:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-12','10:00','Asia/Tokyo')))
    f.store.add({ title:'試験準備課題', category:'assignment', deadlineAt:zonedDateTimeToIso('2026-03-11','23:00','Asia/Tokyo') })
    f.store.add(timed('物理試験', 'exam', zonedDateTimeToIso('2026-03-13','09:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-13','10:00','Asia/Tokyo')))
    const summary = f.store.summary(f.now)
    assert.ok(summary.today.some(row => row.title === '講義'))
    assert.ok(summary.tomorrow.some(row => row.title === '試験準備課題'))
    assert.ok(summary.week.some(row => row.title === '物理試験'))
    assert.equal(summary.nextClass.title, '次の授業')
    assert.ok(summary.upcomingAssignments.length)
    assert.ok(summary.exams.some(row => row.title === '物理試験'))
    assert.equal(summary.current.title, '講義')
    assert.ok(summary.next7Days.some(row => row.title === '次の授業'))
  } finally { f.close() }
})

test('月間予定APIは月境界を守り、個別日予定を展開する', () => {
  const f = fixture()
  try {
    const repeated = f.store.add({ ...timed('講義', 'lesson', zonedDateTimeToIso('2026-03-02','10:00','Asia/Tokyo'), zonedDateTimeToIso('2026-03-02','11:00','Asia/Tokyo')),
      recurrence:{ frequency:'weekly', weekdays:[1], startDate:'2026-03-02', endDate:'2026-04-06', startTime:'10:00', endTime:'11:00' } }).item
    const march = f.store.month(2026, 3)
    assert.equal(march.filter(row => row.parentId === repeated.id).length, 5)
    assert.ok(march.every(row => row.occurrenceDate.startsWith('2026-03')))
  } finally { f.close() }
})

test('予定名とメモをローカル検索し、種類で絞り込める', () => {
  const f = fixture()
  try {
    const lesson = f.store.add(timed('電磁気学', 'lesson', '2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z', { memo:'実験室B' })).item
    f.store.add(timed('力学', 'exam', '2026-03-11T01:00:00Z', '2026-03-11T02:00:00Z'))
    assert.deepEqual(f.store.search('電磁気学').map(row => row.id), [lesson.id])
    assert.deepEqual(f.store.search('実験室').map(row => row.id), [lesson.id])
    assert.deepEqual(f.store.search('学', 'lesson').map(row => row.id), [lesson.id])
    assert.throws(() => f.store.search('学', 'invalid'), /種類/u)
  } finally { f.close() }
})

test('バックアップのエクスポート・重複を避けたインポート・再起動復元を行う', () => {
  const f = fixture()
  const other = fixture()
  try {
    const item = f.store.add(timed('個人予定', 'personal', '2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z')).item
    const snapshot = f.store.exportSnapshot()
    assert.equal(snapshot.format, 'deepseek-chan-calendar')
    assert.deepEqual(other.store.importSnapshot(snapshot), { added:1, duplicates:0 })
    assert.deepEqual(other.store.importSnapshot(snapshot), { added:0, duplicates:1 })
    f.store.update(item.id, { title:'変更後の予定' })
    assert.ok(fs.existsSync(f.store.backupPath))
    const restarted = f.create(); restarted.load()
    assert.equal(restarted.get(item.id).title, '変更後の予定')
  } finally { f.close(); other.close() }
})

test('JSONファイルに安全に書き出し、別ストアで読み込みできる', () => {
  const f = fixture()
  const other = fixture()
  try {
    const row = f.store.add(timed('バックアップ予定', 'personal', '2026-03-12T01:00:00Z', '2026-03-12T02:00:00Z')).item
    const backup = path.join(f.dir, 'export', 'calendar-backup.json')
    assert.equal(f.store.exportFile(backup), true)
    assert.deepEqual(other.store.importFile(backup), { added:1, duplicates:0 })
    assert.equal(other.store.get(row.id).title, row.title)
    assert.equal(fs.readdirSync(path.dirname(backup)).some(name => name.endsWith('.tmp')), false)
  } finally { f.close(); other.close() }
})

test('破損した原本を上書きせず、明示操作ならバックアップから復元できる', () => {
  const f = fixture()
  try {
    const old = f.store.add(timed('保存済み', 'other', '2026-03-10T01:00:00Z')).item
    f.store.update(old.id, { title:'新しい保存済み' })
    fs.writeFileSync(f.file, '{broken calendar')
    const broken = f.create(); broken.load()
    assert.equal(broken.status().writable, false)
    assert.throws(() => broken.add(timed('別予定', 'other', '2026-03-10T03:00:00Z')), /保護中/u)
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken calendar')
    assert.equal(broken.restoreBackup().restored, 1)
    assert.equal(broken.get(old.id).title, '保存済み')
    assert.ok(fs.readdirSync(f.dir).some(name => name.startsWith('calendar.json.corrupt-')))
  } finally { f.close() }
})

test('不正なバックアップの重複IDと過大サイズを復元前に拒否し、原本を保護する', () => {
  const f = fixture()
  try {
    const event = f.store.add(timed('保存済み', 'other', '2026-03-10T01:00:00Z')).item
    fs.writeFileSync(f.file, 'primary-original')
    const broken = f.create(); broken.load()
    fs.writeFileSync(f.store.backupPath, JSON.stringify({ format:'deepseek-chan-calendar', version:1, events:[event, event] }))
    assert.throws(() => broken.restoreBackup(), /重複/u)
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'primary-original')
    fs.writeFileSync(f.store.backupPath, Buffer.alloc(5 * 1024 * 1024 + 1))
    assert.throws(() => broken.restoreBackup(), /サイズ/u)
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'primary-original')
  } finally { f.close() }
})

test('JSONバックアップが不正ならインポートを全体として拒否する', () => {
  const f = fixture()
  try {
    assert.throws(() => f.store.importSnapshot({ format:'deepseek-chan-calendar', version:1, events:[{ title:'X', category:'bad' }] }), /種類/u)
    assert.equal(f.store.list().length, 0)
  } finally { f.close() }
})

test('長期記憶IDとのリンクは参照だけで、カレンダー予定を消しても長期記憶には触れない', () => {
  const f = fixture()
  try {
    const linked = f.store.add(timed('試験', 'exam', '2026-03-10T01:00:00Z', null, { linkedMemoryId:'memory-123' })).item
    assert.equal(f.store.get(linked.id).linkedMemoryId, 'memory-123')
    assert.equal(f.store.delete(linked.id), true)
    assert.equal(f.store.list().length, 0)
  } finally { f.close() }
})
