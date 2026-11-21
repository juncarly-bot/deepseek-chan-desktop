'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const START_DELAY_MS = 5 * 60 * 1000
const MIN_IDLE_MS = 10 * 60 * 1000
const TOPIC_COOLDOWN_MS = 24 * 60 * 60 * 1000
const UNANSWERED_RETRY_MS = 7 * 24 * 60 * 60 * 1000
const UNDATED_FOLLOWUP_MS = 7 * 24 * 60 * 60 * 1000
const DATED_EXPIRY_GRACE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_DAILY_FOLLOWUPS = 2

function dayKey(timestamp) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseClock(value, fallback) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return fallback
  const hour = Number(match[1]); const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : fallback
}

function isQuietTime(now, quietHours = {}) {
  if (quietHours.enabled !== true) return false
  const start = parseClock(quietHours.start, 22 * 60)
  const end = parseClock(quietHours.end, 8 * 60)
  const date = new Date(now)
  const current = date.getHours() * 60 + date.getMinutes()
  if (start === end) return true
  return start < end ? current >= start && current < end : current >= start || current < end
}

function localMorningAfter(timestamp, days = 1) {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

function candidateDueAt(item) {
  const followUp = Date.parse(item?.followUpAt)
  if (Number.isFinite(followUp)) return followUp
  const expires = Date.parse(item?.expiresAt)
  if (Number.isFinite(expires)) return localMorningAfter(expires, 1)
  const created = Date.parse(item?.createdAt)
  if (!Number.isFinite(created)) return Infinity
  return localMorningAfter(created, 7)
}

function normalizeTopic(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 500)
}

function topicKey(item) {
  const identity = item?.groupKey || `${item?.type || ''}:${normalizeTopic(item?.content)}`
  return crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 32)
}

function followUpText(item) {
  const topic = String(item?.content || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)
  if (!topic) return ''
  return `そういえば、この前話していた「${topic}」はその後どう？急がなくて大丈夫だよ。`
}

class FollowUpScheduler {
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.fs = options.fs || fs
    this.now = options.now || Date.now
    this.startDelayMs = Math.max(0, Number(options.startDelayMs ?? START_DELAY_MS))
    this.startedAt = this.now()
    this.events = []
    this.mutedTopics = new Set()
    this.presentedThisLaunch = new Set()
    this.loadError = null
    this.writable = true
    this.load()
  }

  load() {
    this.events = []
    this.mutedTopics = new Set()
    this.loadError = null
    this.writable = true
    if (!this.fs.existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.events) || !Array.isArray(parsed.mutedTopics)) throw new Error('フォローアップ状態の形式が未対応です')
      const events = parsed.events.map(row => {
        if (!row || !/^[a-f0-9]{32}$/.test(row.topicKey) || !Number.isFinite(row.notifiedAt)
            || typeof row.memoryIdHash !== 'string' || !/^[a-f0-9]{32}$/.test(row.memoryIdHash)) return null
        return { topicKey:row.topicKey, memoryIdHash:String(row.memoryIdHash).slice(0, 64), notifiedAt:row.notifiedAt,
          dayKey:dayKey(row.notifiedAt), mode:row.mode === 'voice' ? 'voice' : 'bubble', response:['completed','later','working','muted','dismissed'].includes(row.response) ? row.response : null,
          nextAt:Number.isFinite(row.nextAt) ? row.nextAt : null }
      })
      if (events.some(row => !row)) throw new Error('フォローアップ状態に無効な記録があります')
      const muted = parsed.mutedTopics.filter(key => typeof key === 'string' && /^[a-f0-9]{32}$/.test(key))
      if (muted.length !== parsed.mutedTopics.length) throw new Error('通知停止状態に無効な記録があります')
      this.events = events.slice(-500)
      this.mutedTopics = new Set(muted)
    } catch (error) {
      this.loadError = String(error?.message || '状態を読み込めません').slice(0, 180)
      this.writable = false
    }
  }

  #save() {
    if (!this.writable) throw new Error('通知状態の読み込みに失敗したため、元ファイルを保護しています')
    const directory = path.dirname(this.filePath)
    this.fs.mkdirSync(directory, { recursive:true })
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    let fd = null
    try {
      fd = this.fs.openSync(temp, 'wx', 0o600)
      const data = { version:1, events:this.events.slice(-500), mutedTopics:[...this.mutedTopics] }
      this.fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
      this.fs.fsyncSync(fd)
      this.fs.closeSync(fd); fd = null
      this.fs.renameSync(temp, this.filePath)
      this.loadError = null
    } catch (error) {
      if (fd !== null) { try { this.fs.closeSync(fd) } catch {} }
      try { this.fs.unlinkSync(temp) } catch {}
      throw error
    }
  }

  selectCandidate(items, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : this.now()
    const config = options.config || {}
    if (!this.writable || config.followUpsEnabled !== true || this.presentedThisLaunch.size >= 1) return null
    if (now - this.startedAt < this.startDelayMs || options.busy === true || options.focusMode === true
        || options.fullscreen === true || options.windowAvailable === false
        || !Number.isFinite(options.idleForMs) || options.idleForMs < MIN_IDLE_MS
        || isQuietTime(now, config.quietHours)) return null
    if (options.desktopContextEnabled === true) {
      const context = options.desktopContext
      if (!context?.available || context.foregroundCategory === 'unknown' || typeof context.fullscreenApp !== 'boolean') return null
      if (context.fullscreenApp || ['study_work', 'game'].includes(context.foregroundCategory)) return null
      if (Number.isFinite(context.idleMs) && context.idleMs >= 30 * 60 * 1000) return null
    }
    const limit = Math.max(1, Math.min(MAX_DAILY_FOLLOWUPS, Math.floor(Number(config.dailyMax) || MAX_DAILY_FOLLOWUPS)))
    if (this.events.filter(event => dayKey(event.notifiedAt) === dayKey(now)).length >= limit) return null

    const candidates = (Array.isArray(items) ? items : []).filter(item => {
      if (!['open_loop','commitment'].includes(item?.type) || !['active','planned','postponed'].includes(item?.status)
          || item.sensitive === true) return false
      const expires = Date.parse(item.expiresAt)
      const followUp = Date.parse(item.followUpAt)
      if (!Number.isFinite(followUp) && Number.isFinite(expires) && now > expires + DATED_EXPIRY_GRACE_MS) return false
      const dueAt = candidateDueAt(item)
      if (now < dueAt) return false
      const key = topicKey(item)
      if (this.mutedTopics.has(key) || this.presentedThisLaunch.has(key)) return false
      const related = this.events.filter(event => event.topicKey === key)
      const last = related.at(-1)
      if (related.length >= 2 && (!last || last.response === null || last.response === 'dismissed')) return false
      const requestedReminderDue = last && ['later','working'].includes(last.response)
        && Number.isFinite(last.nextAt) && now >= last.nextAt
      if (last && now - last.notifiedAt < TOPIC_COOLDOWN_MS && !requestedReminderDue) return false
      if (last?.response === 'completed' || last?.response === 'muted') return false
      if (last?.nextAt && now < last.nextAt) return false
      if (last?.response === null && now < last.notifiedAt + UNANSWERED_RETRY_MS) return false
      return true
    })
    candidates.sort((a, b) => candidateDueAt(a) - candidateDueAt(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    return candidates[0] ? { item:{ ...candidates[0] }, dueAt:candidateDueAt(candidates[0]), topicKey:topicKey(candidates[0]) } : null
  }

  recordDelivery(item, mode, now = this.now()) {
    const key = topicKey(item)
    if (this.presentedThisLaunch.size >= 1 || this.presentedThisLaunch.has(key)) return false
    const event = { topicKey:key, memoryIdHash:crypto.createHash('sha256').update(String(item.id)).digest('hex').slice(0, 32),
      notifiedAt:now, dayKey:dayKey(now), mode:mode === 'voice' ? 'voice' : 'bubble', response:null, nextAt:null }
    this.events.push(event)
    this.presentedThisLaunch.add(key)
    try { this.#save() } catch (error) {
      this.events.pop()
      this.presentedThisLaunch.delete(key)
      throw error
    }
    return true
  }

  respond(item, action, options = {}) {
    const key = topicKey(item)
    const hash = crypto.createHash('sha256').update(String(item.id)).digest('hex').slice(0, 32)
    const event = [...this.events].reverse().find(row => row.memoryIdHash === hash && row.topicKey === key && row.response === null)
    if (!event) return false
    const now = Number.isFinite(options.now) ? options.now : this.now()
    const previous = { response:event.response, nextAt:event.nextAt }
    const wasMuted = this.mutedTopics.has(key)
    if (action === 'completed') event.response = 'completed'
    else if (action === 'later' || action === 'working') {
      event.response = action
      const requested = Number(options.nextAt)
      event.nextAt = Number.isFinite(requested) && requested > now
        ? Math.min(requested, now + 365 * 24 * 60 * 60 * 1000)
        : now + UNDATED_FOLLOWUP_MS
    } else if (action === 'mute') {
      event.response = 'muted'
      this.mutedTopics.add(key)
    } else if (action === 'dismiss') event.response = 'dismissed'
    else return false
    try { this.#save() } catch (error) {
      event.response = previous.response
      event.nextAt = previous.nextAt
      if (wasMuted) this.mutedTopics.add(key)
      else this.mutedTopics.delete(key)
      throw error
    }
    return true
  }

  hasPending(item) {
    const key = topicKey(item)
    const hash = crypto.createHash('sha256').update(String(item?.id || '')).digest('hex').slice(0, 32)
    return this.events.some(row => row.topicKey === key && row.memoryIdHash === hash && row.response === null)
  }

  setMuted(item, muted) {
    const key = topicKey(item)
    const wasMuted = this.mutedTopics.has(key)
    if (muted === true) this.mutedTopics.add(key)
    else this.mutedTopics.delete(key)
    try { this.#save() } catch (error) {
      if (wasMuted) this.mutedTopics.add(key)
      else this.mutedTopics.delete(key)
      throw error
    }
    return this.mutedTopics.has(key)
  }

  isMuted(item) { return this.mutedTopics.has(topicKey(item)) }

  status(items = []) {
    return { writable:this.writable, loadError:this.loadError,
      mutedMemoryIds:items.filter(item => this.isMuted(item)).map(item => item.id),
      todayCount:this.events.filter(event => dayKey(event.notifiedAt) === dayKey(this.now())).length }
  }

  clear() {
    const previousEvents = this.events
    const previousMuted = new Set(this.mutedTopics)
    const previousPresented = new Set(this.presentedThisLaunch)
    this.events = []
    this.mutedTopics.clear()
    this.presentedThisLaunch.clear()
    try { this.#save() } catch (error) {
      this.events = previousEvents
      this.mutedTopics = previousMuted
      this.presentedThisLaunch = previousPresented
      throw error
    }
    return true
  }
}

module.exports = { FollowUpScheduler, candidateDueAt, dayKey, followUpText, isQuietTime, localMorningAfter,
  topicKey, START_DELAY_MS, MIN_IDLE_MS, TOPIC_COOLDOWN_MS, UNANSWERED_RETRY_MS, UNDATED_FOLLOWUP_MS,
  DATED_EXPIRY_GRACE_MS, MAX_DAILY_FOLLOWUPS }
