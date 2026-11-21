'use strict'

const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {CalendarPresenceManager,DEFAULT_CALENDAR_PRESENCE,buildBriefing,hasHalfHourGap,isDuringLesson}=require('../src/core/calendar-presence')
const {CalendarStore}=require('../src/core/calendar-store')

function fixture(now=Date.parse('2026-11-08T00:00:00Z')) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-calendar-presence-'))
  let clock=now
  const file=path.join(dir,'calendar-presence.json')
  const create=()=>new CalendarPresenceManager(file,{now:()=>clock})
  return {dir,file,manager:create(),create,get now(){return clock},set now(v){clock=v},close(){fs.rmSync(dir,{recursive:true,force:true})}}
}

function event(overrides={}) { return { id:'e-1',occurrenceId:'e-1::2026-11-08',title:'電磁気学レポート',category:'assignment',
  startAt:null,endAt:null,deadlineAt:'2026-11-09T00:00:00Z',startDate:'2026-11-09',endDate:'2026-11-09',allDay:false,
  timeZone:'Asia/Tokyo',notify:true,taskStatus:'in_progress',completed:false,linkedMemoryId:null,...overrides } }

test('自動機能はすべて初期OFF、手動ブリーフィングはローカル定型文で返す',()=>{
  const f=fixture()
  try {
    assert.equal(DEFAULT_CALENDAR_PRESENCE.briefingEnabled,false)
    assert.equal(DEFAULT_CALENDAR_PRESENCE.classQuietEnabled,false)
    assert.equal(DEFAULT_CALENDAR_PRESENCE.voiceEnabled,false)
    const result=buildBriefing({today:[{category:'lesson',title:'電磁気学'}],tomorrow:[],exams:[],unfinishedAssignments:[]},f.now)
    assert.match(result.spoken,/電磁気学/u)
    assert.equal(result.lines.length,1)
    assert.equal(f.manager.briefing({today:[]},{briefingEnabled:true},f.now,{manual:true}).lines.length,0)
  } finally {f.close()}
})

test('朝の自動まとめは設定時刻後の短い窓に一度だけ出す',()=>{
  const f=fixture(Date.parse('2026-11-08T00:05:00Z'))
  try {
    const config={...DEFAULT_CALENDAR_PRESENCE,briefingEnabled:true,briefingTime:'09:00',quietHours:{enabled:false}}
    const summary={today:[{category:'lesson',title:'授業'}],tomorrow:[],exams:[],unfinishedAssignments:[]}
    assert.equal(f.manager.briefing(summary,config,f.now,{ready:true})?.kind,'briefing')
    const item=f.manager.briefing(summary,config,f.now,{ready:true})
    assert.equal(f.manager.record(item,f.now),true)
    assert.equal(f.manager.briefing(summary,config,f.now,{ready:true}),null)
    assert.equal(f.manager.briefing(summary,config,f.now+20*60_000,{ready:true}),null)
  } finally {f.close()}
})

test('授業中と設定した授業前だけ静音し、休講は対象外',()=>{
  const now=Date.parse('2026-11-08T00:00:00Z')
  const lesson=event({category:'lesson',startAt:new Date(now+10*60_000).toISOString(),endAt:new Date(now+70*60_000).toISOString()})
  assert.equal(isDuringLesson([lesson],now,15),true)
  assert.equal(isDuringLesson([{...lesson,endAt:null}],now,15),false)
  assert.equal(isDuringLesson([{...lesson,startAt:new Date(now+20*60_000).toISOString()}],now,15),false)
})

test('勉強提案は空き時間が30分未満のとき控え、予定が空いていれば許可する',()=>{
  const now=Date.parse('2026-11-08T00:00:00Z')
  assert.equal(hasHalfHourGap([],now),true)
  assert.equal(hasHalfHourGap([event({category:'lesson',startAt:new Date(now+20*60_000).toISOString(),
    endAt:new Date(now+80*60_000).toISOString()})],now),false)
  assert.equal(hasHalfHourGap([event({category:'lesson',startAt:new Date(now+45*60_000).toISOString(),
    endAt:new Date(now+90*60_000).toISOString()})],now),true)
  assert.equal(hasHalfHourGap([event({category:'lesson',allDay:true,startAt:null,endAt:null,
    startDate:'2026-11-08',endDate:'2026-11-08'})],now),false)
})

test('締切通知は設定の時間窓内・未完了のみ、終日試験は深夜扱いしない',()=>{
  const f=fixture()
  try {
    const config={...DEFAULT_CALENDAR_PRESENCE,deadlineRemindersEnabled:true,examRemindersEnabled:true,
      reminderLeadMinutes:1440,quietHours:{enabled:false}}
    const task=event({deadlineAt:new Date(f.now+24*60*60_000).toISOString()})
    const exam=event({id:'exam-1',occurrenceId:'exam-1::2026-11-08',category:'exam',allDay:true,startAt:null,
      deadlineAt:null,startDate:'2026-11-08',endDate:'2026-11-08'})
    assert.equal(f.manager.candidates([task,exam],{today:[],tomorrow:[],exams:[],unfinishedAssignments:[]},config,f.now)[0]?.kind,'deadline')
    assert.equal(f.manager.candidates([{...task,taskStatus:'completed',completed:true}],{},config,f.now).length,0)
  } finally {f.close()}
})

test('通知履歴は本文を保存せず再起動後も重複を防ぐ、後回しと停止を保持する',()=>{
  const f=fixture()
  try {
    const item={key:'a'.repeat(32),eventId:'event::date',kind:'deadline',text:'秘密の本文'}
    assert.equal(f.manager.record(item,f.now),true)
    assert.equal(f.manager.respond(item,'later',f.now),true)
    const raw=fs.readFileSync(f.file,'utf8')
    assert.doesNotMatch(raw,/秘密の本文/u)
    const restored=f.create()
    assert.equal(restored.history().countToday,1)
    assert.equal(restored.record(item,f.now),false)
    f.now+=24*60*60_000
    const afterLater=f.create()
    assert.equal(afterLater.record(item,f.now),true)
    const muted={...item,key:'b'.repeat(32)}
    assert.equal(afterLater.respond(muted,'mute',f.now),true)
    assert.equal(f.create().mutedIds.has(require('../src/core/calendar-presence').stableKey(item.eventId)),true)
  } finally {f.close()}
})

test('通知時刻を過ぎた予定はスリープ復帰後にまとめて鳴らさず、明示リンクだけを返す',()=>{
  const f=fixture()
  try {
    const config={...DEFAULT_CALENDAR_PRESENCE,deadlineRemindersEnabled:true,automaticFollowUpsEnabled:true,
      reminderLeadMinutes:60,quietHours:{enabled:false}}
    const due=event({deadlineAt:new Date(f.now+60*60_000).toISOString(),linkedMemoryId:'memory-explicit'})
    const staleNow=f.now+5*60_000
    assert.equal(f.manager.candidates([due],{},config,staleNow).length,0)
    const exam=event({id:'exam',occurrenceId:'exam::2026-11-08',category:'exam',allDay:false,
      startAt:new Date(f.now-25*60*60_000).toISOString(),endAt:new Date(f.now-24*60*60_000).toISOString(),
      deadlineAt:null,linkedMemoryId:'memory-explicit'})
    const candidate=f.manager.candidates([exam],{},config,f.now)[0]
    assert.equal(candidate.kind,'exam-followup')
    assert.equal(candidate.linkedMemoryId,'memory-explicit')
    assert.doesNotMatch(candidate.text,/memory-explicit/u)
  } finally {f.close()}
})

test('試験の終了時刻がない場合は翌朝9時以降に確認し、終了時刻を推測しない',()=>{
  const f=fixture(Date.parse('2026-11-09T00:00:00Z'))
  try {
    const exam=event({id:'exam-no-end',occurrenceId:'exam-no-end::2026-11-08',category:'exam',allDay:true,
      startAt:null,endAt:null,deadlineAt:null,startDate:'2026-11-08',endDate:'2026-11-08',timeZone:'Asia/Tokyo'})
    const config={...DEFAULT_CALENDAR_PRESENCE,automaticFollowUpsEnabled:true,quietHours:{enabled:false}}
    const candidate=f.manager.candidates([exam],{},config,f.now)[0]
    assert.equal(candidate.kind,'exam-followup')
    assert.equal(candidate.dueAt,Date.parse('2026-11-09T00:00:00Z'))
  } finally {f.close()}
})

test('課題通知の「あとで」は締切前へ再設定し、完了済み予定は再通知しない',()=>{
  const f=fixture()
  try {
    const config={...DEFAULT_CALENDAR_PRESENCE,deadlineRemindersEnabled:true,reminderLeadMinutes:1440,
      quietHours:{enabled:false}}
    const task=event({deadlineAt:new Date(f.now+2*24*60*60_000).toISOString()})
    f.now+=24*60*60_000
    const first=f.manager.candidates([task],{},config,f.now)[0]
    assert.equal(first.kind,'deadline')
    assert.equal(f.manager.record(first,f.now),true)
    assert.equal(f.manager.respond(first,'later',f.now),true)
    f.now+=24*60*60_000-5*60_000
    const resumed=f.create().candidates([task],{},config,f.now)[0]
    assert.equal(resumed.key,first.key)
    assert.equal(f.manager.respond(resumed,'completed',f.now),true)
    assert.equal(f.create().candidates([{...task,completed:true,taskStatus:'completed'}],{},config,f.now).length,0)
  } finally {f.close()}
})

test('静音時間帯は自動通知を止め、カレンダーが空なら候補を作らない',()=>{
  const f=fixture(Date.parse('2026-11-08T14:00:00Z'))
  try {
    const config={...DEFAULT_CALENDAR_PRESENCE,deadlineRemindersEnabled:true,quietHours:{enabled:true,start:'22:00',end:'08:00'}}
    const due=event({deadlineAt:new Date(f.now+24*60*60_000).toISOString()})
    assert.equal(f.manager.candidates([due],{},config,f.now).length,0)
    assert.equal(f.manager.candidates([],{today:[],tomorrow:[],exams:[],unfinishedAssignments:[]},config,f.now).length,0)
  } finally {f.close()}
})

test('授業の週次回は日付別 occurrence id で判定し、休講例外を含めない',()=>{
  const now=Date.parse('2026-11-09T00:00:00Z')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-calendar-presence-store-'))
  try {
    const store=new CalendarStore(path.join(dir,'calendar.json'),{now:()=>now})
    store.load()
    const lesson=store.add({title:'力学',category:'lesson',startAt:'2026-11-09T01:00:00Z',endAt:'2026-11-09T02:00:00Z',
      startDate:'2026-11-09',endDate:'2026-11-09',timeZone:'Asia/Tokyo',recurrence:{frequency:'weekly',weekdays:[1],startDate:'2026-11-09',endDate:'2026-11-30',startTime:'10:00',endTime:'11:00'}}).item
    const rows=store.occurrencesBetween('2026-11-09T00:00:00Z','2026-11-10T00:00:00Z')
    assert.ok(rows.some(row=>row.occurrenceId===`${lesson.id}::2026-11-09`))
    store.deleteOccurrence(`${lesson.id}::2026-11-09`)
    assert.equal(store.occurrencesBetween('2026-11-09T00:00:00Z','2026-11-10T00:00:00Z').length,0)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
