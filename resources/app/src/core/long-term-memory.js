'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MEMORY_TYPES = Object.freeze(['user_fact', 'preference', 'open_loop', 'commitment'])
const MEMORY_STATUSES = Object.freeze(['active', 'planned', 'completed', 'postponed', 'cancelled', 'expired', 'superseded'])
const MAX_CONTENT_CHARS = 500
const MAX_ITEMS = 2000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const OPEN_LOOP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const DATED_FOLLOWUP_GRACE_MS = 14 * 24 * 60 * 60 * 1000
const ACTIVE_STATUSES = new Set(['active', 'planned', 'postponed'])
const SENSITIVE = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:api\s*key|password|passwd|secret|token|パスワード|認証情報|秘密鍵|アクセストークン|クレジットカード|口座番号|住所|電話番号|メールアドレス)\s*[:：=]?\s*\S+|(?:病名|診断|服薬|薬を飲|病院に通|持病|保険証))/i
const HYPOTHETICAL = /(?:もし(?:も)?|仮に|たとえば|例えば|冗談|架空|想像して|if\b|would\b|let's say\b)/i
const CORRECTION = /(?:訂正|さっきの.{0,12}(?:違|間違)|実は|今は|ではなく|じゃなくて|変更した|変わった)/

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS)
}

function normalize(value) {
  return cleanText(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function tokenize(value) {
  const text = cleanText(value).normalize('NFKC').toLowerCase()
  const terms = new Set(text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}|[a-z0-9]{2,}/gu) || [])
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{3,}/gu) || []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2))
  }
  return terms
}

function dueAtFor(text, now) {
  const days = /明後日/.test(text) ? 2 : /明日/.test(text) ? 1 : /今日/.test(text) ? 0 : null
  if (days !== null) {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    date.setHours(23, 59, 59, 999)
    return date.toISOString()
  }
  if (/来週/.test(text)) {
    const date = new Date(now)
    const untilNextMonday = (8 - date.getDay()) % 7 || 7
    date.setDate(date.getDate() + untilNextMonday + 6)
    date.setHours(23, 59, 59, 999)
    return date.toISOString()
  }
  return null
}

function extractCandidates(userText, now = Date.now()) {
  const text = cleanText(userText)
  if (!text || text.length > 1200 || SENSITIVE.test(text) || HYPOTHETICAL.test(text)) return []
  const sentences = text.split(/[。!?！？\n]/u).map(cleanText).filter(Boolean)
  const candidates = []

  for (const sentence of sentences) {
    if (candidates.length >= 3) break
  const study = sentence.match(/(?:僕|私|わたし|俺)(?:は|が)?\s*([^。！？!?]{2,55}?)(?:を勉強して(?:いる|る|います)|を学んで(?:いる|る|います))/u)
    || sentence.match(/([^。！？!?]{2,40}?)(?:を勉強して(?:いる|る|います)|を学んで(?:いる|る|います))/u)
  if (study) {
    const topic = cleanText(study[1]).replace(/^(?:僕|私|わたし|俺)(?:は|が)?\s*/u, '').trim()
    if (topic.length >= 2 && !HYPOTHETICAL.test(topic)) candidates.push({
      type:'user_fact', content:`${topic}を勉強している`, groupKey:`study:${normalize(topic)}`,
      confidence:0.86, status:'active', expiresAt:null,
    })
  }

  if (/(?:説明|解説|教え方|回答|返事)/u.test(sentence) && /(?:してほしい|して欲しい|含めてほしい|含めて欲しい|がいい|が好き|重視したい|重視してほしい|優先して)/u.test(sentence)) {
    const area = /数学/u.test(sentence) ? '数学' : /物理|電磁気/u.test(sentence) ? '物理' : '一般'
    const detail = /途中式|途中の式/u.test(sentence) ? '途中式を含めて説明してほしい'
      : /簡潔|短く/u.test(sentence) ? '簡潔な説明をしてほしい'
        : /詳しく|丁寧/u.test(sentence) ? '詳しい説明をしてほしい' : null
    if (detail) candidates.push({ type:'preference', content:`${area}の説明は${detail}`, groupKey:`preference:explanation:${area}`,
      confidence:0.88, status:'active', expiresAt:null })
  }

  const likes = sentence.match(/(?:僕|私|わたし|俺)(?:は|が)?\s*([^。！？!?]{2,48}?)(?:が好き|が好み|が趣味)/u)
  if (likes) {
    const subject = cleanText(likes[1]).replace(/^(?:僕|私|わたし|俺)(?:は|が)?\s*/u, '').trim()
    if (subject.length >= 2) candidates.push({ type:'user_fact', content:`${subject}が好き`, groupKey:`interest:${normalize(subject)}`,
      confidence:0.82, status:'active', expiresAt:null })
  }

  const taskWords = '(?:試験|テスト|課題|レポート|問題|提出|応募|面接|発表)'
  const hasTask = new RegExp(taskWords, 'u').test(sentence)
  const commitmentSignal = /(?:予定|つもり|約束|することにした|やるよ|提出する|取り組む|解く)/u.test(sentence)
  const openLoopSignal = /(?:結果待ち|まだ.{0,8}(?:解け|終わ|決ま)|未解決|が近い|がある|に取り組んで|を進めて|を解いて|を待って)/u.test(sentence)
  if (hasTask && (commitmentSignal || openLoopSignal)) {
    const type = commitmentSignal ? 'commitment' : 'open_loop'
    const subjectMatch = sentence.match(new RegExp(`([^。！？!?]{2,65}?${taskWords}[^。！？!?]{0,24})`, 'u'))
    const content = cleanText(subjectMatch?.[1] || sentence)
    const due = dueAtFor(sentence, now)
    candidates.push({ type, content, groupKey:`${type}:${normalize(content).replace(/(?:が近い|がある|を待っている|に取り組んでいる|を進めている|する予定|するつもり|を提出する|を解く)$/u, '')}`,
      confidence:0.84, status:type === 'commitment' ? 'planned' : 'active', expiresAt:due })
  }
  }
  return candidates.slice(0, 3)
}

function makeItem(candidate, source = {}, now = Date.now()) {
  const type = MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'user_fact'
  const status = MEMORY_STATUSES.includes(candidate.status) ? candidate.status : type === 'commitment' ? 'planned' : 'active'
  const expiry = candidate.expiresAt && Number.isFinite(Date.parse(candidate.expiresAt)) ? new Date(candidate.expiresAt).toISOString() : null
  return {
    id:randomUUID(), type, content:cleanText(candidate.content),
    sourceConversationId:cleanText(source.conversationId || '').slice(0, 120) || null,
    sourceMessageId:cleanText(source.messageId || '').slice(0, 120) || null,
    sourceType:source.manual === true ? 'manual' : 'conversation',
    createdAt:new Date(now).toISOString(), updatedAt:new Date(now).toISOString(),
    confidence:source.manual === true ? 1 : Math.max(0, Math.min(1, Number(candidate.confidence) || 0.8)),
    confirmed:source.manual === true, expiresAt:expiry,
    followUpAt:candidate.followUpAt && Number.isFinite(Date.parse(candidate.followUpAt)) ? new Date(candidate.followUpAt).toISOString() : null,
    status,
    groupKey:cleanText(candidate.groupKey || '').slice(0, 180) || null,
    sensitive:SENSITIVE.test(candidate.content), replacesId:null,
  }
}

class LongTermMemoryStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.fs = options.fs || fs
    this.now = options.now || Date.now
    this.maxItems = options.maxItems || MAX_ITEMS
    this.items = []
    this.loadError = null
    this.writable = true
  }

  load() {
    this.items = []
    this.loadError = null
    this.writable = true
    if (!this.fs.existsSync(this.filePath)) return this.items
    try {
      if (this.fs.statSync(this.filePath).size > MAX_FILE_BYTES) throw new Error('記憶ファイルが許容サイズを超えています')
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.items)) throw new Error('記憶ファイルの形式が未対応です')
      const normalized = parsed.items.map(row => this.#normalizeLoaded(row))
      if (normalized.some(row => !row)) throw new Error('記憶ファイルに無効な記録が含まれています')
      this.items = normalized.slice(-this.maxItems)
    } catch (error) {
      this.loadError = String(error?.message || '記憶ファイルを読み込めません').slice(0, 180)
      this.writable = false
    }
    return this.list({ skipExpiry:true })
  }

  #normalizeLoaded(row) {
    if (!row || !MEMORY_TYPES.includes(row.type) || !MEMORY_STATUSES.includes(row.status)) return null
    if (!cleanText(row.content)) return null
    const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date(this.now()).toISOString()
    return {
      id:cleanText(row.id) || randomUUID(), type:row.type, content:cleanText(row.content),
      sourceConversationId:cleanText(row.sourceConversationId || '') || null,
      sourceMessageId:cleanText(row.sourceMessageId || '') || null,
      sourceType:row.sourceType === 'manual' ? 'manual' : 'conversation',
      createdAt:date(row.createdAt), updatedAt:date(row.updatedAt),
      confidence:Math.max(0, Math.min(1, Number(row.confidence) || 0)), confirmed:row.confirmed === true,
      expiresAt:Number.isFinite(Date.parse(row.expiresAt)) ? new Date(row.expiresAt).toISOString() : null,
      followUpAt:Number.isFinite(Date.parse(row.followUpAt)) ? new Date(row.followUpAt).toISOString() : null,
      status:row.status, groupKey:cleanText(row.groupKey || '') || null,
      sensitive:row.sensitive === true || SENSITIVE.test(row.content),
      replacesId:cleanText(row.replacesId || '') || null,
    }
  }

  #save(nextItems) {
    if (!this.writable) throw new Error('記憶ファイルの読み込みに失敗したため、元ファイルを保護しています')
    const directory = path.dirname(this.filePath)
    this.fs.mkdirSync(directory, { recursive:true })
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    let fd = null
    try {
      fd = this.fs.openSync(temp, 'wx', 0o600)
      this.fs.writeFileSync(fd, JSON.stringify({ version:1, items:nextItems }, null, 2), 'utf8')
      this.fs.fsyncSync(fd)
      this.fs.closeSync(fd)
      fd = null
      this.fs.renameSync(temp, this.filePath)
      this.items = nextItems
      this.loadError = null
    } catch (error) {
      if (fd !== null) { try { this.fs.closeSync(fd) } catch {} }
      try { this.fs.unlinkSync(temp) } catch {}
      throw error
    }
  }

  #commit(mutator) {
    const next = this.items.map(item => ({ ...item }))
    const result = mutator(next)
    if (result?.changed) this.#save(next.slice(-this.maxItems))
    return result?.value
  }

  #expireDue() {
    const now = this.now()
    const effectiveExpiry = item => item.followUpAt || item.expiresAt
    const isStaleLoop = item => ['open_loop', 'commitment'].includes(item.type)
      && now - (Number.isFinite(Date.parse(item.followUpAt)) ? Date.parse(item.followUpAt) : Date.parse(item.updatedAt)) >= OPEN_LOOP_MAX_AGE_MS
    const due = this.items.some(item => ACTIVE_STATUSES.has(item.status)
      && ((effectiveExpiry(item) && Date.parse(effectiveExpiry(item)) + DATED_FOLLOWUP_GRACE_MS <= now) || isStaleLoop(item)))
    if (!due || !this.writable) return
    this.#commit(items => {
      let changed = false
      for (const item of items) {
        if (ACTIVE_STATUSES.has(item.status)
          && ((effectiveExpiry(item) && Date.parse(effectiveExpiry(item)) + DATED_FOLLOWUP_GRACE_MS <= now) || isStaleLoop(item))) {
          item.status = 'expired'; item.updatedAt = new Date(now).toISOString(); changed = true
        }
      }
      return { changed, value:null }
    })
  }

  list(options = {}) {
    if (!options.skipExpiry) this.#expireDue()
    return this.items.map(item => ({ ...item }))
  }

  addManual(input = {}) {
    if (!MEMORY_TYPES.includes(input.type)) throw new Error('記憶の分類が無効です')
    const content = cleanText(input.content)
    if (content.length < 2) throw new Error('記憶内容を2文字以上入力してください')
    const allowedStatus = MEMORY_STATUSES.includes(input.status) ? input.status : input.type === 'commitment' ? 'planned' : 'active'
    const candidate = { type:input.type, content, groupKey:cleanText(input.groupKey || '') || null,
      status:allowedStatus, expiresAt:input.expiresAt || null, confidence:1 }
    const item = makeItem(candidate, { manual:true }, this.now())
    return this.#commit(items => {
      const duplicate = items.find(existing => existing.type === item.type && normalize(existing.content) === normalize(item.content)
        && ACTIVE_STATUSES.has(existing.status))
      if (duplicate) {
        Object.assign(duplicate, { updatedAt:item.updatedAt, confirmed:true, sourceType:'manual', confidence:1,
          sourceConversationId:null, sourceMessageId:null })
        return { changed:true, value:{ ...duplicate, duplicate:true } }
      }
      items.push(item)
      return { changed:true, value:{ ...item } }
    })
  }

  update(id, patch = {}) {
    return this.#commit(items => {
      const item = items.find(row => row.id === id)
      if (!item) return { changed:false, value:null }
      if (patch.type !== undefined) {
        if (!MEMORY_TYPES.includes(patch.type)) throw new Error('記憶の分類が無効です')
        item.type = patch.type
      }
      if (patch.content !== undefined) {
        const content = cleanText(patch.content)
        if (content.length < 2) throw new Error('記憶内容を2文字以上入力してください')
        item.content = content
        item.sensitive = SENSITIVE.test(content)
      }
      if (patch.status !== undefined) {
        if (!MEMORY_STATUSES.includes(patch.status)) throw new Error('記憶の状態が無効です')
        item.status = patch.status
      }
      if (patch.expiresAt !== undefined) {
        if (patch.expiresAt !== null && !Number.isFinite(Date.parse(patch.expiresAt))) throw new Error('期限が無効です')
        item.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt).toISOString()
      }
      if (patch.followUpAt !== undefined) {
        if (patch.followUpAt !== null && !Number.isFinite(Date.parse(patch.followUpAt))) throw new Error('確認予定日時が無効です')
        item.followUpAt = patch.followUpAt === null ? null : new Date(patch.followUpAt).toISOString()
      }
      if (patch.confirmed !== undefined) item.confirmed = patch.confirmed === true
      item.updatedAt = new Date(this.now()).toISOString()
      return { changed:true, value:{ ...item } }
    })
  }

  delete(id) {
    return this.#commit(items => {
      const index = items.findIndex(item => item.id === id)
      if (index < 0) return { changed:false, value:false }
      items.splice(index, 1)
      return { changed:true, value:true }
    })
  }

  clear() {
    this.#save([])
    return true
  }

  addCandidate(candidate, source = {}) {
    if (!candidate || !MEMORY_TYPES.includes(candidate.type)) throw new Error('記憶候補の分類が無効です')
    const content = cleanText(candidate.content)
    if (content.length < 2) throw new Error('記憶候補の内容が無効です')
    const item = makeItem({ ...candidate, content }, source, this.now())
    return this.#commit(items => {
      const same = items.find(existing => ACTIVE_STATUSES.has(existing.status) && existing.type === item.type
        && ((item.groupKey && existing.groupKey === item.groupKey) || normalize(existing.content) === normalize(item.content)))
      if (same && normalize(same.content) === normalize(item.content)) {
        same.updatedAt = item.updatedAt
        same.sourceConversationId = item.sourceConversationId || same.sourceConversationId
        same.sourceMessageId = item.sourceMessageId || same.sourceMessageId
        same.confidence = Math.max(same.confidence, item.confidence)
        return { changed:true, value:{ ...same, duplicate:true } }
      }
      if (same) {
        same.status = 'superseded'
        same.updatedAt = item.updatedAt
        item.replacesId = same.id
      }
      items.push(item)
      return { changed:true, value:{ ...item } }
    })
  }

  hasCandidateSource(messageId, candidate) {
    if (!messageId || !candidate || !MEMORY_TYPES.includes(candidate.type)) return false
    const content = normalize(candidate.content)
    return this.items.some(item => item.sourceMessageId === String(messageId) && item.type === candidate.type
      && ((candidate.groupKey && item.groupKey === candidate.groupKey) || normalize(item.content) === content))
  }

  extractFromUserText(text, source = {}) {
    if (!this.writable) return { added:0, skipped:true, reason:'storage-unavailable' }
    const candidates = extractCandidates(text, this.now())
    const statusChange = this.#detectStatusChange(cleanText(text))
    let added = 0
    for (const candidate of candidates) {
      this.addCandidate(candidate, source)
      added++
    }
    if (statusChange) this.#applyStatusChange(statusChange)
    return { added, skipped:false }
  }

  #detectStatusChange(text) {
    const status = /(?:延期|先送りにした|延期になった)/u.test(text) ? 'postponed'
      : /(?:取り消した|キャンセルした|中止した|やめることにした)/u.test(text) ? 'cancelled'
        : /(?:終わった|完了した|提出した|解決した|結果が出た|済ませた)/u.test(text) ? 'completed' : null
    if (!status) return null
    const terms = tokenize(text)
    return { status, terms }
  }

  #applyStatusChange(change) {
    this.#commit(items => {
      let changed = false
      const now = new Date(this.now()).toISOString()
      for (const item of items) {
        if (!['open_loop', 'commitment'].includes(item.type) || !ACTIVE_STATUSES.has(item.status)) continue
        const memoryTerms = tokenize(item.content)
        const overlap = [...change.terms].filter(term => memoryTerms.has(term)).length
        if (overlap < 1) continue
        item.status = change.status
        item.updatedAt = now
        changed = true
      }
      return { changed, value:null }
    })
  }

  searchRelevant(query, options = {}) {
    this.#expireDue()
    const terms = tokenize(query)
    if (!terms.size) return []
    const excludeId = options.excludeSourceMessageId || null
    const maxItems = Math.max(1, Math.min(5, Number(options.maxItems) || 3))
    const maxChars = Math.max(120, Math.min(1600, Number(options.maxChars) || 900))
    const ranked = []
    for (const item of this.items) {
      if (!ACTIVE_STATUSES.has(item.status) || item.sensitive || (excludeId && item.sourceMessageId === excludeId)) continue
      const memoryTerms = tokenize(item.content)
      const overlap = [...terms].reduce((sum, term) => sum + (memoryTerms.has(term) ? 1 : 0), 0)
      if (!overlap) continue
      const score = overlap / Math.max(1, Math.min(terms.size, 6)) + Math.min(0.08, item.confidence * 0.08)
      if (score < 0.22) continue
      ranked.push({ item, score })
    }
    ranked.sort((a, b) => b.score - a.score || Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt))
    const result = []
    let used = 0
    for (const row of ranked.slice(0, maxItems)) {
      const size = [...row.item.content].length
      if (used + size > maxChars) continue
      result.push({ ...row.item, relevance:Math.min(1, row.score) })
      used += size
    }
    return result
  }

  status() {
    return { storagePath:this.filePath, writable:this.writable, loadError:this.loadError, count:this.items.length }
  }
}

module.exports = { LongTermMemoryStore, MEMORY_TYPES, MEMORY_STATUSES, extractCandidates, tokenize, SENSITIVE }
