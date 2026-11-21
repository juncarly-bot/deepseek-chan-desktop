'use strict'
/**
 * history.js — 会話履歴の保存・参照
 *
 * 履歴は JSON ファイル（既定: <userData>/chat-history.json、開発時は app/data/）に保存する。
 * - 起動時に読み込み、過去の会話を画面に復元できる
 * - DeepSeek へ送る際は直近 N ターンだけをコンテキストとして切り出す
 * - キーワード検索で過去の発言を探せる
 */
const fs = require('fs')
const path = require('path')

class HistoryStore {
  /**
   * @param {string} filePath 保存先 JSON のパス
   * @param {{maxItems?:number}} [opts] 保持する最大件数（古いものから削除）
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath
    this.maxItems = opts.maxItems || 1000
    this.items = []
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(raw)
      this.items = Array.isArray(data) ? data : data.items || []
    } catch {
      this.items = []
    }
    return this.items
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  /**
   * 1件追加して保存する。
   * @param {'user'|'assistant'} role
   * @param {string} content タグ除去済みの表示用テキスト
   * @param {object} [meta] emotion など任意の付帯情報
   */
  add(role, content, meta = {}) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content: String(content || ''),
      emotion: meta.emotion || null,
      ts: new Date().toISOString(),
    }
    this.items.push(item)
    if (this.items.length > this.maxItems) {
      this.items = this.items.slice(this.items.length - this.maxItems)
    }
    this.save()
    return item
  }

  list() {
    return [...this.items]
  }

  search(query) {
    const q = String(query || '').trim()
    if (!q) return this.list()
    return this.items.filter((i) => i.content.includes(q))
  }

  clear() {
    this.items = []
    this.save()
  }

  /**
   * DeepSeek API に渡す messages 配列を作る。
   * system プロンプト + 直近 maxTurns ターン（user/assistant の組）まで。
   */
  buildMessages(systemPrompt, maxTurns = 12) {
    const msgs = [{ role: 'system', content: systemPrompt }]
    const convo = this.items
      .filter((i) => i.role === 'user' || i.role === 'assistant')
      .slice(-Math.max(2, maxTurns * 2))
    for (const i of convo) msgs.push({ role: i.role, content: i.content })
    return msgs
  }
}

module.exports = { HistoryStore }
