'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { addDateKey, dateKeyInZone, zonedDateTimeToIso } = require('./calendar-store')

const DAY = 86400_000
const DEFAULT_CALENDAR_PRESENCE = Object.freeze({
  briefingEnabled:false, briefingTime:'08:00', classQuietEnabled:false, classQuietLeadMinutes:15,
  deadlineRemindersEnabled:false, examRemindersEnabled:false, eventRemindersEnabled:false,
  automaticFollowUpsEnabled:false, studyRivalEnabled:false, voiceEnabled:false, allowCloudVoice:false,
  reminderLeadMinutes:1440, quietHours:{ enabled:true, start:'22:00', end:'08:00' }, pausedUntil:null,
})

function localDay(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function parseClock(value, fallback = '08:00') {
  const match = /^(\d{2}):(\d{2})$/u.exec(String(value || ''))
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return fallback
  return `${match[1]}:${match[2]}`
}

function inQuietHours(now, quiet = {}) {
  if (quiet.enabled !== true) return false
  const toMin = value => { const [h,m] = parseClock(value,'22:00').split(':').map(Number); return h*60+m }
  const start = toMin(quiet.start), end = toMin(quiet.end)
  const d = new Date(now), minute = d.getHours()*60+d.getMinutes()
  if (start === end) return true
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

function eventKey(event) { return String(event?.occurrenceId || event?.id || '') }
function stableKey(value) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,32) }
function activeTask(event) { return !event.completed && !['completed','cancelled'].includes(event.taskStatus) }
function daysUntilLocalDate(dateKey,now) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(dateKey||''))) return NaN
  const [year,month,day]=dateKey.split('-').map(Number)
  const [currentYear,currentMonth,currentDay]=localDay(now).split('-').map(Number)
  return Math.round((Date.UTC(year,month-1,day)-Date.UTC(currentYear,currentMonth-1,currentDay))/DAY)
}
function within(now, at, beforeMs, afterMs = 2 * 60_000) {
  return Number.isFinite(at) && now >= at-beforeMs && now <= at+afterMs
}

function isDuringLesson(events, now = Date.now(), leadMinutes = 0) {
  const lead = Math.max(0, Math.min(180, Number(leadMinutes) || 0)) * 60_000
  return (Array.isArray(events) ? events : []).some(event => {
    if (event.category !== 'lesson' || event.allDay || !event.startAt || !event.endAt) return false
    const start = Date.parse(event.startAt), end = Date.parse(event.endAt)
    return Number.isFinite(start) && Number.isFinite(end) && now >= start-lead && now < end
  })
}

function hasHalfHourGap(events,now=Date.now()) {
  const rows=Array.isArray(events)?events:[]
  for (const event of rows) {
    if (event.allDay && ['lesson','exam','personal','other'].includes(event.category)) {
      const today=event.occurrenceDate||dateKeyInZone(now,event.timeZone)
      if (today>=event.startDate && today<=event.endDate) return false
    }
    if (!event.startAt || !event.endAt) continue
    const start=Date.parse(event.startAt), end=Date.parse(event.endAt)
    if (Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&end>now) return false
  }
  const nextStart=rows.map(event=>Date.parse(event.startAt)).filter(at=>Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0]
  return !Number.isFinite(nextStart) || nextStart-now>=30*60_000
}

function buildBriefing(summary = {}, now = Date.now()) {
  const today = (summary.today || []).filter(event => event.category === 'lesson' || event.category === 'study')
  const exams = (summary.exams || []).filter(event => {
    const at = Date.parse(event.startAt || event.deadlineAt || `${event.startDate}T12:00:00`)
    return event.category === 'exam' && Number.isFinite(at) && at >= now && at-now <= 14*DAY
  }).slice(0,1)
  const tasks = (summary.unfinishedAssignments || []).filter(activeTask).filter(event => event.deadlineAt && Date.parse(event.deadlineAt) >= now)
    .sort((a,b) => Date.parse(a.deadlineAt)-Date.parse(b.deadlineAt)).slice(0,2)
  const lines = []
  if (today.some(event => event.category === 'lesson')) lines.push(`今日の授業：${today.filter(event=>event.category==='lesson').map(event=>event.title).join('、')}`)
  if (exams.length) lines.push(`近い試験：${exams.map(event=>event.title).join('、')}`)
  if (tasks.length) lines.push(`締切が近い課題：${tasks.map(event=>event.title).join('、')}`)
  if (today.some(event => event.category === 'study')) lines.push(`今日の勉強予定：${today.filter(event=>event.category==='study').map(event=>event.title).join('、')}`)
  const tomorrow = (summary.tomorrow || []).filter(event => ['exam','assignment'].includes(event.category) && activeTask(event))
  if (tomorrow.length) lines.push(`明日の大切な予定：${tomorrow.slice(0,2).map(event=>event.title).join('、')}`)
  const date = new Date(now)
  const greeting = date.getHours() < 11 ? 'おはよう' : date.getHours() < 17 ? 'こんにちは' : 'こんばんは'
  const spoken = lines.length ? `${greeting}、きみ。${lines[0]}${lines.length > 1 ? `。${lines[1]}` : ''}。` : `${greeting}、きみ。今日はカレンダーに予定がないみたい。ゆっくりいこうね。`
  return { day:localDay(now), lines, spoken, hasEvents:lines.length > 0 }
}

class CalendarPresenceManager {
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.fs = options.fs || fs
    this.now = options.now || Date.now
    this.events = []
    this.pausedUntil = null
    this.briefedDays = new Set()
    this.mutedIds = new Set()
    this.snoozed = new Map()
    this.writable = true
    this.loadError = null
    this.load()
  }

  load() {
    if (!this.fs.existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath,'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.deliveries) || !Array.isArray(parsed.briefedDays)
        || !Array.isArray(parsed.mutedIds) || !Array.isArray(parsed.snoozed)) throw new Error('通知履歴の形式が未対応です')
      this.events = parsed.deliveries.filter(row => row && /^[a-f0-9]{32}$/u.test(row.key)
        && Number.isFinite(row.at) && Number.isFinite(row.day)).slice(-1000)
      this.briefedDays = new Set(parsed.briefedDays.filter(value => /^\d{4}-\d{2}-\d{2}$/u.test(value)))
      this.mutedIds = new Set(parsed.mutedIds.filter(value => /^[a-f0-9]{32}$/u.test(value)))
      this.snoozed = new Map(parsed.snoozed.filter(row => row && /^[a-f0-9]{32}$/u.test(row.key) && Number.isFinite(row.until)).map(row=>[row.key,row.until]))
      this.pausedUntil = Number.isFinite(parsed.pausedUntil) ? parsed.pausedUntil : null
      if (this.events.length !== parsed.deliveries.length) throw new Error('通知履歴に無効な記録があります')
    } catch (error) {
      this.writable = false
      this.loadError = String(error?.message || '通知履歴を読み込めません').slice(0,160)
    }
  }

  #save() {
    if (!this.writable) throw new Error('通知履歴を保護中のため変更できません')
    this.fs.mkdirSync(path.dirname(this.filePath), {recursive:true})
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    let fd
    try {
      fd = this.fs.openSync(tmp,'wx',0o600)
      this.fs.writeFileSync(fd, JSON.stringify({ version:1, deliveries:this.events.slice(-1000), briefedDays:[...this.briefedDays].slice(-60),
        mutedIds:[...this.mutedIds].slice(-500), snoozed:[...this.snoozed].slice(-500).map(([key,until])=>({key,until})), pausedUntil:this.pausedUntil },null,2),'utf8')
      this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = undefined
      this.fs.renameSync(tmp,this.filePath)
    } catch (error) {
      if (fd !== undefined) { try { this.fs.closeSync(fd) } catch {} }
      try { this.fs.unlinkSync(tmp) } catch {}
      throw error
    }
  }

  isPaused(now = this.now()) { return this.pausedUntil !== null && this.pausedUntil > now }

  pause(until) {
    const previous = this.pausedUntil
    this.pausedUntil = Number.isFinite(until) ? Math.min(until, this.now()+30*DAY) : this.now()+DAY
    try { this.#save(); return this.pausedUntil } catch (error) { this.pausedUntil = previous; throw error }
  }

  resume() { const previous=this.pausedUntil; this.pausedUntil=null; try { this.#save(); return true } catch(error) { this.pausedUntil=previous; throw error } }

  briefing(summary, config = {}, now = this.now(), options = {}) {
    if (options.manual === true) return buildBriefing(summary,now)
    if (config.briefingEnabled !== true || options.ready !== true || options.busy === true || options.suppressed === true
      || this.isPaused(now) || inQuietHours(now,config.quietHours)) return null
    const date = new Date(now), [h,m] = parseClock(config.briefingTime).split(':').map(Number)
    const due = new Date(date); due.setHours(h,m,0,0)
    if (now < due.getTime() || now-due.getTime() > 15*60_000) return null
    const day=localDay(now)
    if (this.briefedDays.has(day)) return null
    const result=buildBriefing(summary,now)
    if (!result.lines.length) return null
    return { ...result, key:`briefing:${day}`, priority:40, kind:'briefing', eventId:null }
  }

  classQuiet(events, config = {}, now = this.now()) {
    return config.classQuietEnabled === true && isDuringLesson(events,now,config.classQuietLeadMinutes)
  }

  candidates(events, summary, config = {}, now = this.now()) {
    if (this.isPaused(now) || inQuietHours(now,config.quietHours)) return []
    const out=[]
    for (const event of Array.isArray(events)?events:[]) {
      const id=eventKey(event); if (!id) continue
      const isActive=activeTask(event)
      const title=String(event.title||'予定').slice(0,80)
      if (event.notify && event.category==='assignment' && config.deadlineRemindersEnabled && isActive && event.deadlineAt) {
        const due=Date.parse(event.deadlineAt), lead=Math.max(5,Math.min(10080,Number(config.reminderLeadMinutes)||1440))*60_000
        const identity=`deadline:${id}:${due}`
        if ((within(now,due-lead,0) || this.#snoozeDue(identity,now)) && due>now) out.push(this.#candidate(identity,10,'deadline',id,`締切が近い課題「${title}」があるよ。進み具合はどう？`,event))
      }
      if (event.notify && event.category==='exam' && config.examRemindersEnabled && !event.allDay && event.startAt) {
        const at=Date.parse(event.startAt), lead=Math.max(5,Math.min(10080,Number(config.reminderLeadMinutes)||1440))*60_000
        const identity=`exam:${id}:${at}`
        if ((within(now,at-lead,0) || this.#snoozeDue(identity,now)) && at>now) out.push(this.#candidate(identity,20,'exam',id,`試験「${title}」が近づいているね。準備はどう？`,event))
      }
      if (event.notify && !['exam','assignment'].includes(event.category) && config.eventRemindersEnabled && !event.allDay && event.startAt) {
        const at=Date.parse(event.startAt), lead=Math.max(5,Math.min(10080,Number(config.eventLeadMinutes ?? config.reminderLeadMinutes)||30))*60_000
        const identity=`event:${id}:${at}`
        if ((within(now,at-lead,0) || this.#snoozeDue(identity,now)) && at>now) out.push(this.#candidate(identity,10,'event',id,`「${title}」の予定が近いよ。`,event))
      }
      if (config.automaticFollowUpsEnabled && event.category==='exam') {
        const eventDate=event.occurrenceDate || (event.startAt?dateKeyInZone(Date.parse(event.startAt),event.timeZone):event.startDate)
        const at=event.endAt?Date.parse(event.endAt)+DAY
          : eventDate?Date.parse(zonedDateTimeToIso(addDateKey(eventDate,1),'09:00',event.timeZone)):NaN
        const identity=`exam-followup:${id}:${Number.isFinite(at)?new Date(at).toISOString():'unknown'}`
        if (within(now,at,15*60_000,15*60_000) || this.#snoozeDue(identity,now)) out.push(this.#candidate(identity,25,'exam-followup',id,`この前の「${title}」、どうだった？話したくなったら聞かせてね。`,event,at))
      }
      if (config.studyRivalEnabled && hasHalfHourGap(events,now) && ['exam','assignment'].includes(event.category) && isActive) {
        const lead=event.category==='exam'?7*DAY:3*DAY
        const due=Date.parse(event.startAt||event.deadlineAt)
        const days=Number.isFinite(due)?(due-now)/DAY:daysUntilLocalDate(event.startDate,now)
        if (days>=0 && days<=lead/DAY) {
          out.push(this.#candidate(`study:${id}`,50,'study',id,`「${title}」に向けて、少し復習する？始める・あとで・今日は休む、どれでも大丈夫だよ。`,event))
        }
      }
    }
    const brief=this.briefing(summary,config,now,{ready:true})
    if (brief) out.push(brief)
    return out.filter(item=>this.#eligible(item,now)).sort((a,b)=>a.priority-b.priority || a.dueAt-b.dueAt)
  }

  #candidate(identity,priority,kind,eventId,text,event,dueAtOverride=undefined) {
    const key=stableKey(identity)
    return { key,priority,kind,eventId,text,linkedMemoryId:event?.linkedMemoryId||null,
      dueAt:Number.isFinite(dueAtOverride)?dueAtOverride:Date.parse(event?.deadlineAt||event?.startAt||event?.endAt||'')||0 }
  }

  #snoozeDue(identity,now) {
    const key=stableKey(identity)
    return this.events.some(row=>row.key===key && Number.isFinite(row.nextAt) && now>=row.nextAt)
  }

  #eligible(item,now) {
    if (this.mutedIds.has(stableKey(item.eventId))) return false
    const previous=[...this.events].reverse().find(row=>row.key===item.key)
    if (!previous) return true
    return Number.isFinite(previous.nextAt) && now>=previous.nextAt
  }

  record(item,now=this.now()) {
    if (!item?.key || this.#eligible(item,now)===false) return false
    const row={key:item.key,at:now,day:Number(`${new Date(now).getFullYear()}${String(new Date(now).getMonth()+1).padStart(2,'0')}${String(new Date(now).getDate()).padStart(2,'0')}`),nextAt:null}
    this.events.push(row)
    if (item.kind==='briefing') this.briefedDays.add(localDay(now))
    try { this.#save(); return true } catch(error) { this.events.pop(); if(item.kind==='briefing')this.briefedDays.delete(localDay(now)); throw error }
  }

  respond(item,action,now=this.now()) {
    if (!item?.key || !['later','rest','mute','completed','dismiss'].includes(action)) return false
    const beforeMute=this.mutedIds.has(stableKey(item.eventId)), prior=this.snoozed.get(item.key)
    const delivery=[...this.events].reverse().find(row=>row.key===item.key)
    const previousNextAt=delivery?.nextAt
    let nextAt=null
    if (action==='mute') this.mutedIds.add(stableKey(item.eventId))
    else if (action==='rest') nextAt=new Date(now).setHours(23,59,59,999)
    else if (action==='later') nextAt=now+DAY
    if (['deadline','exam','event'].includes(item.kind) && Number.isFinite(item.dueAt) && item.dueAt>now) {
      nextAt=Math.min(nextAt||Infinity,item.dueAt-5*60_000)
      if(nextAt<=now) nextAt=null
    }
    if (['rest','later'].includes(action) && Number.isFinite(nextAt)) this.snoozed.set(item.key,nextAt)
    else this.snoozed.delete(item.key)
    if (delivery) delivery.nextAt=Number.isFinite(nextAt)?nextAt:null
    try { this.#save(); return true } catch(error) {
      if(!beforeMute)this.mutedIds.delete(stableKey(item.eventId))
      if(prior===undefined)this.snoozed.delete(item.key); else this.snoozed.set(item.key,prior)
      if(delivery) delivery.nextAt=previousNextAt
      throw error
    }
  }

  history() { return { paused:this.isPaused(), pausedUntil:this.pausedUntil, countToday:this.events.filter(row=>row.day===Number(`${new Date(this.now()).getFullYear()}${String(new Date(this.now()).getMonth()+1).padStart(2,'0')}${String(new Date(this.now()).getDate()).padStart(2,'0')}`)).length,
    entries:this.events.slice(-30).map(row=>({ at:row.at })) , writable:this.writable, error:this.loadError } }

  static reminderEvents(calendarStore,now=Date.now()) {
    const start=new Date(now-3*DAY).toISOString(), end=new Date(now+8*DAY).toISOString()
    return calendarStore.occurrencesBetween(start,end)
  }
}

module.exports={ CalendarPresenceManager, DEFAULT_CALENDAR_PRESENCE, buildBriefing, hasHalfHourGap, inQuietHours, isDuringLesson, stableKey }
