'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const CATEGORIES = Object.freeze(['lesson', 'exam', 'assignment', 'study', 'personal', 'other'])
const TASK_STATUSES = Object.freeze(['not_started', 'in_progress', 'completed', 'cancelled'])
const MAX_EVENTS = 10000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const SECRET_TEXT = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\bbearer\s+[A-Za-z0-9._~+/-]{12,}|(?:api\s*key|password|passwd|secret|token|パスワード|認証情報|秘密鍵|アクセストークン|クレジットカード|口座番号|メールアドレス)\s*[:：=]\s*\S+)/iu
const EVENT_FIELDS = ['title', 'category', 'startAt', 'endAt', 'deadlineAt', 'allDay', 'startDate', 'endDate',
  'timeZone', 'memo', 'notify', 'completed', 'taskStatus']

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)
}

function dateKeyValid(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function addDateKey(value, days) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function weekday(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function dateKeyInZone(timestamp, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(timestamp))
  const part = Object.fromEntries(parts.map(item => [item.type, item.value]))
  return `${part.year}-${part.month}-${part.day}`
}

function validTimeZone(value) {
  const timeZone = String(value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); return timeZone }
  catch { throw new Error('タイムゾーンが無効です') }
}

function zonedDateTimeToIso(dateKey, time, timeZone) {
  if (!dateKeyValid(dateKey) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(String(time || ''))) throw new Error('日時が無効です')
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let guess = target
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' })
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]))
    const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
    const diff = target - rendered
    if (diff === 0) break
    guess += diff
  }
  const result = new Date(guess)
  if (!Number.isFinite(result.getTime())) throw new Error('日時が無効です')
  const verified = Object.fromEntries(formatter.formatToParts(result).map(part => [part.type, part.value]))
  if (Number(verified.year) !== year || Number(verified.month) !== month || Number(verified.day) !== day
      || Number(verified.hour) !== hour || Number(verified.minute) !== minute) throw new Error('このタイムゾーンでは指定した時刻が存在しません')
  return result.toISOString()
}

function parseStoredInstant(value, name) {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${name}が無効です`)
  return date.toISOString()
}

function splitLocalInput(value, fallbackZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!value) return null
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/u)
  if (!match) throw new Error('日時の形式が無効です')
  return zonedDateTimeToIso(match[1], match[2], fallbackZone)
}

function normalizeBase(input = {}, now = Date.now(), preserve = {}) {
  const title = clean(input.title, 120)
  const memo = clean(input.memo, 2000)
  if (title.length < 1) throw new Error('予定名を入力してください')
  if (SECRET_TEXT.test(`${title} ${memo}`)) throw new Error('認証情報や秘密情報はカレンダーに保存できません')
  if (!CATEGORIES.includes(input.category)) throw new Error('予定の種類が無効です')
  const allDay = input.allDay === true
  const timeZone = validTimeZone(input.timeZone)
  const startAt = parseStoredInstant(input.startAt, '開始日時')
  const endAt = parseStoredInstant(input.endAt, '終了日時')
  const deadlineAt = parseStoredInstant(input.deadlineAt, '締切日時')
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new Error('終了日時は開始日時より後にしてください')
  if (deadlineAt && startAt && Date.parse(deadlineAt) < Date.parse(startAt)) throw new Error('締切日時は開始日時より前にできません')
  const startDate = input.startDate ? String(input.startDate) : startAt ? dateKeyInZone(startAt, timeZone) : deadlineAt ? dateKeyInZone(deadlineAt, timeZone) : ''
  const endDate = input.endDate ? String(input.endDate) : startDate
  if (!dateKeyValid(startDate) || !dateKeyValid(endDate) || endDate < startDate) throw new Error('日付が無効です')
  const recurrenceInput = input.recurrence || null
  let recurrence = null
  if (recurrenceInput) {
    if (recurrenceInput.frequency !== 'weekly') throw new Error('繰り返しの種類が無効です')
    const weekdays = [...new Set((Array.isArray(recurrenceInput.weekdays) ? recurrenceInput.weekdays : []).map(Number))].sort((a, b) => a - b)
    if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('繰り返す曜日を選んでください')
    const repeatStart = String(recurrenceInput.startDate || startDate)
    const repeatEnd = String(recurrenceInput.endDate || '')
    if (!dateKeyValid(repeatStart) || !dateKeyValid(repeatEnd) || repeatEnd < repeatStart) throw new Error('繰り返し期間を確認してください')
    const startTime = String(recurrenceInput.startTime || (startAt ? new Intl.DateTimeFormat('en-GB', { timeZone, hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(startAt)) : ''))
    const endTime = String(recurrenceInput.endTime || (endAt ? new Intl.DateTimeFormat('en-GB', { timeZone, hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(endAt)) : ''))
    const endDayOffset = Number(recurrenceInput.endDayOffset) === 1 ? 1 : 0
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(endTime)) throw new Error('繰り返し時刻が無効です')
    if (endDayOffset === 0 && endTime <= startTime) throw new Error('終了時刻が開始時刻より後になるよう設定してください')
    recurrence = { frequency:'weekly', weekdays, startDate:repeatStart, endDate:repeatEnd, startTime, endTime, endDayOffset }
  }
  const taskStatus = input.category === 'assignment'
    ? (TASK_STATUSES.includes(input.taskStatus) ? input.taskStatus : input.completed === true ? 'completed' : 'not_started')
    : input.category === 'study' && TASK_STATUSES.includes(input.taskStatus) ? input.taskStatus : 'not_applicable'
  const completed = input.completed === true || taskStatus === 'completed'
  return {
    id:preserve.id || clean(input.id, 80) || crypto.randomUUID(), title, category:input.category,
    startAt, endAt, deadlineAt, allDay, startDate, endDate, timeZone,
    memo, notify:input.notify === true, completed,
    taskStatus:completed && taskStatus !== 'not_applicable' ? 'completed' : taskStatus,
    recurrence, exceptions:preserve.exceptions || {},
    linkedMemoryId:clean(input.linkedMemoryId, 80) || null,
    source:'local', createdAt:preserve.createdAt || parseStoredInstant(input.createdAt, '作成日時') || new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),
  }
}

function editableSnapshot(event) {
  return Object.fromEntries(EVENT_FIELDS.map(field => [field, event[field]]))
}

function eventSignature(event) {
  return JSON.stringify({ title:event.title.normalize('NFKC').toLowerCase(), category:event.category, startAt:event.startAt,
    endAt:event.endAt, deadlineAt:event.deadlineAt, allDay:event.allDay, startDate:event.startDate, endDate:event.endDate,
    timeZone:event.timeZone, recurrence:event.recurrence })
}

function validateExceptionMap(value, event, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('繰り返し例外の形式が無効です')
  const output = {}
  for (const [date, row] of Object.entries(value)) {
    if (!dateKeyValid(date) || !event.recurrence || date < event.recurrence.startDate || date > event.recurrence.endDate) throw new Error('繰り返し例外の日付が無効です')
    if (!row || typeof row !== 'object' || Array.isArray(row) || (row.cancelled !== true && (!row.override || typeof row.override !== 'object'))) throw new Error('繰り返し例外の内容が無効です')
    if (row.cancelled === true) { output[date] = { cancelled:true }; continue }
    const base = occurrenceFrom(event, date)
    const normalized = normalizeBase({ ...base, ...row.override, recurrence:null, exceptions:{}, id:event.id }, now, { id:event.id, createdAt:event.createdAt })
    output[date] = { cancelled:false, override:editableSnapshot(normalized) }
  }
  return output
}

function normalizeLoadedEvent(row, now = Date.now()) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.source && row.source !== 'local') throw new Error('カレンダー記録の形式が無効です')
  const base = normalizeBase(row, now, { id:clean(row.id, 80), createdAt:parseStoredInstant(row.createdAt, '作成日時') || new Date(now).toISOString(), exceptions:{} })
  base.updatedAt = parseStoredInstant(row.updatedAt, '更新日時') || base.updatedAt
  base.exceptions = validateExceptionMap(row.exceptions || {}, base, now)
  return base
}

function occurrenceFrom(event, date) {
  const recurrence = event.recurrence
  const startAt = zonedDateTimeToIso(date, recurrence.startTime, event.timeZone)
  const endDate = addDateKey(date, recurrence.endDayOffset)
  const endAt = zonedDateTimeToIso(endDate, recurrence.endTime, event.timeZone)
  const exception = event.exceptions?.[date]
  if (exception?.cancelled) return null
  return { ...event, ...(exception?.override || {}), id:event.id, occurrenceId:`${event.id}::${date}`,
    parentId:event.id, occurrenceDate:date, recurring:true, startAt:exception?.override?.startAt || startAt,
    endAt:exception?.override?.endAt || endAt, deadlineAt:exception?.override?.deadlineAt || null,
    startDate:date, endDate, recurrence:event.recurrence }
}

function compareOccurrences(a, b) {
  const aTime = a.startAt ? Date.parse(a.startAt) : a.deadlineAt ? Date.parse(a.deadlineAt) : Date.parse(`${a.startDate}T00:00:00Z`)
  const bTime = b.startAt ? Date.parse(b.startAt) : b.deadlineAt ? Date.parse(b.deadlineAt) : Date.parse(`${b.startDate}T00:00:00Z`)
  return aTime - bTime || a.title.localeCompare(b.title, 'ja')
}

class CalendarStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.backupPath = `${filePath}.bak`
    this.fs = options.fs || fs
    this.now = options.now || Date.now
    this.events = []
    this.writable = true
    this.loadError = null
  }

  load() {
    this.events = []
    this.writable = true
    this.loadError = null
    if (!this.fs.existsSync(this.filePath)) return []
    try {
      if (this.fs.statSync(this.filePath).size > MAX_FILE_BYTES) throw new Error('カレンダーファイルが許容サイズを超えています')
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
      if (parsed?.format !== 'deepseek-chan-calendar' || parsed.version !== 1 || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) throw new Error('カレンダーファイルの形式が未対応です')
      const events = parsed.events.map(row => normalizeLoadedEvent(row, this.now()))
      if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('重複した予定IDがあります')
      this.events = events
    } catch (error) {
      this.writable = false
      this.loadError = String(error?.message || 'カレンダーを読み込めません').slice(0, 180)
    }
    return this.list()
  }

  #save(next) {
    if (!this.writable) throw new Error('カレンダーファイルを保護中のため変更できません')
    if (next.length > MAX_EVENTS) throw new Error('予定が上限件数を超えています')
    const folder = path.dirname(this.filePath)
    this.fs.mkdirSync(folder, { recursive:true })
    const payload = JSON.stringify({ format:'deepseek-chan-calendar', version:1, events:next }, null, 2)
    if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) throw new Error('カレンダーが許容サイズを超えています')
    const suffix = `${process.pid}.${crypto.randomUUID()}`
    const temp = `${this.filePath}.${suffix}.tmp`
    const backupTemp = `${this.backupPath}.${suffix}.tmp`
    let fd = null
    let backupMade = false
    try {
      if (this.fs.existsSync(this.filePath)) {
        const current = this.fs.readFileSync(this.filePath, 'utf8')
        let parsed
        try {
          parsed = JSON.parse(current)
          if (parsed?.format !== 'deepseek-chan-calendar' || parsed.version !== 1 || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) throw new Error('形式が無効です')
          const checked = parsed.events.map(row => normalizeLoadedEvent(row, this.now()))
          if (new Set(checked.map(event => event.id)).size !== checked.length) throw new Error('予定IDが重複しています')
        } catch {
          this.writable = false
          this.loadError = '既存カレンダーが不正なため、元ファイルを保護しています'
          throw new Error(this.loadError)
        }
        fd = this.fs.openSync(backupTemp, 'wx', 0o600)
        this.fs.writeFileSync(fd, current, 'utf8'); this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = null
        this.fs.renameSync(backupTemp, this.backupPath)
        backupMade = true
      }
      fd = this.fs.openSync(temp, 'wx', 0o600)
      this.fs.writeFileSync(fd, payload, 'utf8'); this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = null
      this.fs.renameSync(temp, this.filePath)
      this.events = next
      this.loadError = null
      return true
    } catch (error) {
      if (fd !== null) { try { this.fs.closeSync(fd) } catch {} }
      try { this.fs.unlinkSync(temp) } catch {}
      try { this.fs.unlinkSync(backupTemp) } catch {}
      throw error
    }
  }

  status() { return { writable:this.writable, loadError:this.loadError, count:this.events.length, storagePath:this.filePath, backupPath:this.backupPath } }
  list() { return this.events.map(event => structuredClone(event)) }
  get(id) { const found = this.events.find(event => event.id === String(id || '')); return found ? structuredClone(found) : null }

  search(query, category = '') {
    const needle = clean(query, 120).normalize('NFKC').toLocaleLowerCase('ja-JP')
    if (!needle) return []
    if (category && !CATEGORIES.includes(category)) throw new Error('予定の種類が無効です')
    return this.events.filter(event => (!category || event.category === category)
      && `${event.title} ${event.memo}`.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(needle))
      .sort((a,b) => (a.startAt || a.deadlineAt || a.startDate).localeCompare(b.startAt || b.deadlineAt || b.startDate))
      .slice(0, 100).map(event => structuredClone(event))
  }

  add(input) {
    const event = normalizeBase(input, this.now())
    const duplicate = this.events.find(row => eventSignature(row) === eventSignature(event))
    if (duplicate) return { item:structuredClone(duplicate), duplicate:true }
    this.#save([...this.events, event])
    return { item:structuredClone(event), duplicate:false }
  }

  update(id, patch = {}) {
    const index = this.events.findIndex(event => event.id === String(id || ''))
    if (index < 0) return null
    const previous = this.events[index]
    const next = normalizeBase({ ...previous, ...patch }, this.now(), { id:previous.id, createdAt:previous.createdAt, exceptions:previous.exceptions })
    const retainedExceptions = next.recurrence ? Object.fromEntries(Object.entries(previous.exceptions).filter(([date]) =>
      date >= next.recurrence.startDate && date <= next.recurrence.endDate && next.recurrence.weekdays.includes(weekday(date)))) : {}
    next.exceptions = validateExceptionMap(retainedExceptions, next, this.now())
    if (eventSignature(next) !== eventSignature(previous) && this.events.some((event, i) => i !== index && eventSignature(event) === eventSignature(next))) throw new Error('同じ予定がすでに登録されています')
    const events = this.events.slice(); events[index] = next; this.#save(events)
    return structuredClone(next)
  }

  delete(id) {
    const events = this.events.filter(event => event.id !== String(id || ''))
    if (events.length === this.events.length) return false
    this.#save(events); return true
  }

  updateOccurrence(occurrenceId, patch = {}) {
    const { id, date } = this.#parseOccurrenceId(occurrenceId)
    const index = this.events.findIndex(event => event.id === id)
    if (index < 0 || !this.events[index].recurrence) return null
    const parent = this.events[index]
    if (date < parent.recurrence.startDate || date > parent.recurrence.endDate || !parent.recurrence.weekdays.includes(weekday(date))) return null
    const current = occurrenceFrom(parent, date)
    if (!current) return null
    const normalized = normalizeBase({ ...current, ...patch, recurrence:null, exceptions:{} }, this.now(), { id, createdAt:parent.createdAt, exceptions:{} })
    const exception = { cancelled:false, override:editableSnapshot(normalized) }
    const updated = { ...parent, updatedAt:new Date(this.now()).toISOString(), exceptions:{ ...parent.exceptions, [date]:exception } }
    const events = this.events.slice(); events[index] = updated; this.#save(events)
    return occurrenceFrom(updated, date)
  }

  deleteOccurrence(occurrenceId) {
    const { id, date } = this.#parseOccurrenceId(occurrenceId)
    const index = this.events.findIndex(event => event.id === id)
    if (index < 0 || !this.events[index].recurrence) return false
    const parent = this.events[index]
    if (date < parent.recurrence.startDate || date > parent.recurrence.endDate || !parent.recurrence.weekdays.includes(weekday(date))) return false
    const updated = { ...parent, updatedAt:new Date(this.now()).toISOString(), exceptions:{ ...parent.exceptions, [date]:{ cancelled:true } } }
    const events = this.events.slice(); events[index] = updated; this.#save(events); return true
  }

  #parseOccurrenceId(value) {
    const text = String(value || '')
    const split = text.lastIndexOf('::')
    if (split <= 0 || !dateKeyValid(text.slice(split + 2))) throw new Error('繰り返し予定の指定が無効です')
    return { id:text.slice(0, split), date:text.slice(split + 2) }
  }

  occurrencesBetween(startAt, endAt) {
    const start = new Date(startAt).getTime(); const end = new Date(endAt).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('検索期間が無効です')
    const output = []
    for (const event of this.events) {
      if (event.recurrence) {
        const queryStartDate = addDateKey(dateKeyInZone(start, event.timeZone), -1)
        const queryEndDate = dateKeyInZone(end - 1, event.timeZone)
        let date = event.recurrence.startDate > queryStartDate ? event.recurrence.startDate : queryStartDate
        const last = event.recurrence.endDate < queryEndDate ? event.recurrence.endDate : queryEndDate
        while (date <= last) {
          if (event.recurrence.weekdays.includes(weekday(date))) {
            const occurrence = occurrenceFrom(event, date)
            if (occurrence && Date.parse(occurrence.endAt) > start && Date.parse(occurrence.startAt) < end) output.push(occurrence)
          }
          date = addDateKey(date, 1)
        }
      } else if (event.allDay) {
        let date = event.startDate
        while (date <= event.endDate) {
          const dayStart = Date.parse(zonedDateTimeToIso(date, '00:00', event.timeZone))
          const nextStart = Date.parse(zonedDateTimeToIso(addDateKey(date, 1), '00:00', event.timeZone))
          if (nextStart > start && dayStart < end) output.push({ ...structuredClone(event), occurrenceId:`${event.id}::${date}`, occurrenceDate:date })
          date = addDateKey(date, 1)
        }
      } else {
        const anchor = event.startAt || event.deadlineAt
        if (!anchor) continue
        const endValue = event.endAt || event.deadlineAt || event.startAt
        if (Date.parse(endValue) >= start && Date.parse(anchor) < end) output.push({ ...structuredClone(event), occurrenceId:`${event.id}::${dateKeyInZone(anchor, event.timeZone)}`, occurrenceDate:dateKeyInZone(anchor, event.timeZone) })
      }
    }
    return output.sort(compareOccurrences)
  }

  occurrencesForDate(date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    if (!dateKeyValid(date)) throw new Error('日付が無効です')
    const start = zonedDateTimeToIso(date, '00:00', timeZone)
    const end = zonedDateTimeToIso(addDateKey(date, 1), '00:00', timeZone)
    return this.occurrencesBetween(start, end)
  }

  summary(now = this.now()) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const todayKey = dateKeyInZone(now, zone)
    const tomorrowKey = addDateKey(todayKey, 1)
    const start = zonedDateTimeToIso(todayKey, '00:00', zone)
    const tomorrow = zonedDateTimeToIso(tomorrowKey, '00:00', zone)
    const sevenDaysEnd = zonedDateTimeToIso(addDateKey(todayKey, 7), '00:00', zone)
    const weekStart = addDateKey(todayKey, -((weekday(todayKey) + 6) % 7))
    const weekEnd = addDateKey(weekStart, 7)
    const weekBeginIso = zonedDateTimeToIso(weekStart, '00:00', zone)
    const weekEndIso = zonedDateTimeToIso(weekEnd, '00:00', zone)
    const today = this.occurrencesBetween(start, tomorrow)
    const tomorrowEvents = this.occurrencesBetween(tomorrow, zonedDateTimeToIso(addDateKey(tomorrowKey, 1), '00:00', zone))
    const week = this.occurrencesBetween(weekBeginIso, weekEndIso)
    const next7Days = this.occurrencesBetween(start, sevenDaysEnd)
    const all = this.occurrencesBetween(new Date(now - 30 * 86400_000).toISOString(), new Date(now + 30 * 86400_000).toISOString())
    const current = all.find(event => {
      if (event.startAt && event.endAt) return Date.parse(event.startAt) <= now && Date.parse(event.endAt) > now
      if (!event.allDay) return false
      const date = event.occurrenceDate || event.startDate
      const nextDate = addDateKey(event.occurrenceDate || event.endDate, 1)
      return Date.parse(zonedDateTimeToIso(date, '00:00', event.timeZone)) <= now
        && Date.parse(zonedDateTimeToIso(nextDate, '00:00', event.timeZone)) > now
    }) || null
    const nextClass = all.find(event => event.category === 'lesson' && event.startAt && Date.parse(event.startAt) > now) || null
    const assignments = all.filter(event => event.category === 'assignment' && event.deadlineAt
        && Date.parse(event.deadlineAt) >= now && !['completed','cancelled'].includes(event.taskStatus))
      .sort((a,b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt))
    const unfinishedAssignments = this.events.filter(event => event.category === 'assignment' && !['completed','cancelled'].includes(event.taskStatus))
      .sort((a,b) => (Date.parse(a.deadlineAt || '9999-12-31T23:59:59Z') || Infinity) - (Date.parse(b.deadlineAt || '9999-12-31T23:59:59Z') || Infinity))
    const exams = this.events.filter(event => event.category === 'exam'
        && ((event.endAt && Date.parse(event.endAt) > now) || ((event.startAt || event.deadlineAt) && Date.parse(event.startAt || event.deadlineAt) >= now)))
      .sort((a,b) => Date.parse(a.startAt || a.deadlineAt || '9999-12-31T23:59:59Z') - Date.parse(b.startAt || b.deadlineAt || '9999-12-31T23:59:59Z'))
    return { today, tomorrow:tomorrowEvents, week, next7Days, nextClass, upcomingAssignments:assignments,
      unfinishedAssignments, exams, current }
  }

  month(year, month) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('表示する月が無効です')
    const first = `${year}-${String(month).padStart(2, '0')}-01`
    const after = addDateKey(first, new Date(Date.UTC(year, month, 0)).getUTCDate())
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return this.occurrencesBetween(zonedDateTimeToIso(first, '00:00', zone), zonedDateTimeToIso(after, '00:00', zone))
  }

  exportSnapshot() {
    return { format:'deepseek-chan-calendar', version:1, exportedAt:new Date(this.now()).toISOString(), events:this.list() }
  }

  exportFile(filePath) {
    const payload = JSON.stringify(this.exportSnapshot(), null, 2)
    if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) throw new Error('バックアップが許容サイズを超えています')
    const folder = path.dirname(filePath)
    this.fs.mkdirSync(folder, { recursive:true })
    const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    let fd = null
    try {
      fd = this.fs.openSync(temp, 'wx', 0o600)
      this.fs.writeFileSync(fd, payload, 'utf8'); this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = null
      this.fs.renameSync(temp, filePath)
      return true
    } catch (error) {
      if (fd !== null) { try { this.fs.closeSync(fd) } catch {} }
      try { this.fs.unlinkSync(temp) } catch {}
      throw error
    }
  }

  importFile(filePath) {
    const stat = this.fs.statSync(filePath)
    if (stat.size > MAX_FILE_BYTES) throw new Error('バックアップファイルが許容サイズを超えています')
    const snapshot = JSON.parse(this.fs.readFileSync(filePath, 'utf8'))
    return this.importSnapshot(snapshot)
  }

  importSnapshot(snapshot) {
    if (!snapshot || snapshot.format !== 'deepseek-chan-calendar' || snapshot.version !== 1
      || !Array.isArray(snapshot.events) || snapshot.events.length > MAX_EVENTS) throw new Error('バックアップ形式が無効です')
    const imported = snapshot.events.map(row => normalizeLoadedEvent(row, this.now()))
    const next = this.events.slice()
    const ids = new Set(next.map(event => event.id))
    const signatures = new Set(next.map(eventSignature))
    let added = 0; let duplicates = 0
    for (const event of imported) {
      if (ids.has(event.id) || signatures.has(eventSignature(event))) { duplicates++; continue }
      next.push(event); ids.add(event.id); signatures.add(eventSignature(event)); added++
    }
    this.#save(next)
    return { added, duplicates }
  }

  restoreBackup() {
    if (!this.fs.existsSync(this.backupPath)) throw new Error('復元できるバックアップがありません')
    if (this.fs.statSync(this.backupPath).size > MAX_FILE_BYTES) throw new Error('バックアップが許容サイズを超えています')
    const backup = JSON.parse(this.fs.readFileSync(this.backupPath, 'utf8'))
    if (backup?.format !== 'deepseek-chan-calendar' || backup.version !== 1 || !Array.isArray(backup.events)
      || backup.events.length > MAX_EVENTS) throw new Error('バックアップが壊れています')
    const events = backup.events.map(row => normalizeLoadedEvent(row, this.now()))
    if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('バックアップに重複した予定IDがあります')
    if (this.fs.existsSync(this.filePath)) this.fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${this.now()}-${crypto.randomUUID().slice(0, 8)}`)
    const folder = path.dirname(this.filePath)
    this.fs.mkdirSync(folder, { recursive:true })
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.restore.tmp`
    let fd = null
    try {
      fd = this.fs.openSync(temp, 'wx', 0o600)
      this.fs.writeFileSync(fd, JSON.stringify({ format:'deepseek-chan-calendar', version:1, events }, null, 2), 'utf8')
      this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = null
      this.fs.renameSync(temp, this.filePath)
      this.events = events; this.writable = true; this.loadError = null
    } catch (error) {
      if (fd !== null) { try { this.fs.closeSync(fd) } catch {} }
      try { this.fs.unlinkSync(temp) } catch {}
      throw error
    }
    return { restored:events.length }
  }
}

module.exports = { CalendarStore, CATEGORIES, TASK_STATUSES, addDateKey, dateKeyInZone,
  dateKeyValid, normalizeBase, splitLocalInput, weekday, zonedDateTimeToIso }
