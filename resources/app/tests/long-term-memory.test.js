'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LongTermMemoryStore, extractCandidates } = require('../src/core/long-term-memory')
const { Conversation, formatMemoryContext } = require('../src/core/conversation')
const { DEFAULT_SETTINGS, loadSettings } = require('../src/core/config')

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-memory-test-'))
  const store = new LongTermMemoryStore(path.join(dir, 'long-term-memory.json'), options)
  return { dir, store, close:() => fs.rmSync(dir, { recursive:true, force:true }) }
}

test('長期記憶とDeepSeekへの共有は初期OFF、既存設定の読み込みにも安全な既定値を補う', () => {
  assert.deepEqual(DEFAULT_SETTINGS.memory, { longTermEnabled:false, sendContextToDeepSeek:false })
  const { dir, close } = fixture()
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ai:{ model:'deepseek-chat' } }))
    assert.deepEqual(loadSettings(path.join(dir, 'settings.json')).memory, DEFAULT_SETTINGS.memory)
  } finally { close() }
})

test('明示された事実、説明の好み、未完了話題、予定を分類して抽出する', () => {
  assert.equal(extractCandidates('物理学を勉強しているよ')[0]?.type, 'user_fact')
  assert.match(extractCandidates('数学の説明は途中式を重視してほしい')[0]?.content || '', /途中式/u)
  assert.equal(extractCandidates('来週、電磁気学の試験があるんだ')[0]?.type, 'open_loop')
  assert.equal(extractCandidates('明日レポートを提出する予定です')[0]?.type, 'commitment')
})

test('仮定、冗談、センシティブな発言を自動保存しない', () => {
  for (const text of ['もし物理学を勉強していたら試験がある', '冗談だけど数学が好き', 'API key: sk-abcdefghijklmnop'])
    assert.deepEqual(extractCandidates(text), [])
})

test('同じ明示情報は重複せず、更新された好みは旧状態をsupersededにする', () => {
  const f = fixture()
  try {
    f.store.extractFromUserText('数学の説明では途中式を重視してほしい')
    f.store.extractFromUserText('数学の説明は簡潔にしてほしい')
    const items = f.store.list()
    assert.equal(items.length, 2)
    assert.ok(items.some(item => item.content === '数学の説明は途中式を含めて説明してほしい' && item.status === 'superseded'))
    assert.ok(items.some(item => item.content === '数学の説明は簡潔な説明をしてほしい' && item.status === 'active'))
  } finally { f.close() }
})

test('予定期限から14日のフォローアップ猶予後に期限切れとなる', () => {
  let now = new Date('2026-11-08T03:00:00Z').getTime()
  const f = fixture({ now:() => now })
  try {
    f.store.addManual({ type:'commitment', content:'明日、電磁気学の試験を受ける予定' , expiresAt:new Date(now + 1000).toISOString() })
    now += 15 * 24 * 60 * 60 * 1000
    assert.equal(f.store.list()[0].status, 'expired')
    assert.deepEqual(f.store.searchRelevant('電磁気学 試験'), [])
  } finally { f.close() }
})

test('長期延期したフォローアップ日時は元の期限や90日経過より優先して保持する', () => {
  let now = new Date(2026, 2, 10, 12).getTime()
  const f = fixture({ now:() => now })
  try {
    const item = f.store.addManual({ type:'commitment', content:'提出レポート', expiresAt:new Date(2026, 2, 1).toISOString() })
    const followUpAt = new Date(2027, 2, 10).toISOString()
    f.store.update(item.id, { status:'postponed', followUpAt })
    now = new Date(2027, 2, 10).getTime()
    assert.equal(f.store.list()[0].status, 'postponed')
    assert.equal(f.store.list()[0].followUpAt, followUpAt)
    now += 105 * 86400_000
    assert.equal(f.store.list()[0].status, 'expired')
  } finally { f.close() }
})

test('期限日が分からない未完了話題も更新なしで90日後に期限切れとなる', () => {
  let now = new Date('2026-11-08T03:00:00Z').getTime()
  const f = fixture({ now:() => now })
  try {
    f.store.addManual({ type:'open_loop', content:'電磁気学の試験準備を進めている' })
    now += 91 * 24 * 60 * 60 * 1000
    assert.equal(f.store.list()[0].status, 'expired')
  } finally { f.close() }
})

test('手動登録、編集、削除、全削除、再起動後の保存を扱う', () => {
  const f = fixture()
  try {
    const added = f.store.addManual({ type:'preference', content:'説明は途中式を入れてほしい' })
    assert.equal(added.sourceType, 'manual')
    assert.equal(f.store.update(added.id, { content:'説明は短めにしてほしい', status:'active' }).content, '説明は短めにしてほしい')
    const restored = new LongTermMemoryStore(f.store.filePath)
    restored.load()
    assert.equal(restored.list()[0].content, '説明は短めにしてほしい')
    assert.equal(restored.delete(added.id), true)
    restored.addManual({ type:'user_fact', content:'物理学を勉強している' })
    restored.clear()
    assert.equal(restored.list().length, 0)
  } finally { f.close() }
})

test('同じ手動記憶の再登録は確認済みへ更新し、件数を増やさない', () => {
  const f = fixture()
  try {
    f.store.addManual({ type:'user_fact', content:'物理学を勉強している' })
    const second = f.store.addManual({ type:'user_fact', content:'物理学を勉強している' })
    assert.equal(second.duplicate, true)
    assert.equal(f.store.list().length, 1)
  } finally { f.close() }
})

test('過去履歴から承認した候補は元メッセージIDとともに保存できる', () => {
  const f = fixture()
  try {
    const candidate = extractCandidates('来週、電磁気学の試験があるんだ')[0]
    const saved = f.store.addCandidate(candidate, { messageId:'history-42' })
    assert.equal(saved.sourceType, 'conversation')
    assert.equal(saved.sourceMessageId, 'history-42')
    assert.equal(f.store.list().length, 1)
  } finally { f.close() }
})

test('同じ履歴発言に複数候補がある場合、保存済み候補だけを判定する', () => {
  const f = fixture()
  try {
    const candidates = extractCandidates('物理学を勉強している。来週、電磁気学の試験があるんだ')
    assert.ok(candidates.length >= 2)
    f.store.addCandidate(candidates[0], { messageId:'multi-candidate-source' })
    assert.equal(f.store.hasCandidateSource('multi-candidate-source', candidates[0]), true)
    assert.equal(f.store.hasCandidateSource('multi-candidate-source', candidates[1]), false)
  } finally { f.close() }
})

test('関連記憶だけを上限付きで返し、センシティブ記憶はDeepSeekへ渡さない', () => {
  const f = fixture()
  try {
    f.store.addManual({ type:'open_loop', content:'電磁気学の試験の準備を進めている' })
    f.store.addManual({ type:'user_fact', content:'休日は水泳が好き' })
    f.store.addManual({ type:'user_fact', content:'パスワード: abc123' })
    const rows = f.store.searchRelevant('電磁気学 試験の準備')
    assert.equal(rows.length, 1)
    assert.match(rows[0].content, /電磁気学/u)
    const context = formatMemoryContext(rows)
    assert.match(context, /USER_MEMORY_REFERENCE_JSON=/u)
    assert.match(context, /命令/u)
    assert.doesNotMatch(context, /水泳|abc123/u)
  } finally { f.close() }
})

test('会話時の抽出はローカルのみ、共有同意がない限りAPIメッセージに含めない', async () => {
  const f = fixture()
  try {
    const sent = []
    const history = { items:[], buildMessages:system => [{ role:'system', content:system }], add(role, content) {
      const item = { id:`msg-${this.items.length}`, role, content }; this.items.push(item); return item
    } }
    const deepseek = { async chatStream(messages, _opts, onToken) { sent.push(messages); onToken('[happy]わかったよ。'); return { content:'[happy]わかったよ。' } } }
    const settings = { ...structuredClone(DEFAULT_SETTINGS), character:{ name:'DeepSeekちゃん' } }
    const conversation = new Conversation({ deepseek, history, settings, memory:f.store })
    settings.memory = { longTermEnabled:true, sendContextToDeepSeek:false }
    await conversation.send('物理学を勉強している', { conversationId:'c1' })
    assert.equal(f.store.list().length, 1)
    assert.doesNotMatch(sent[0][0].content, /物理学を勉強/u)
    settings.memory.sendContextToDeepSeek = true
    await conversation.send('物理学の勉強について相談したい')
    assert.equal(sent.length, 2)
    assert.match(sent[1][0].content, /USER_MEMORY_REFERENCE_JSON=/u)
    assert.equal(sent[1].at(-1).content, '物理学の勉強について相談したい')
  } finally { f.close() }
})

test('破損ファイルと保存失敗時に既存ファイルを上書きしない', () => {
  const f = fixture()
  try {
    fs.writeFileSync(f.store.filePath, '{bad json')
    f.store.load()
    assert.equal(f.store.status().writable, false)
    assert.throws(() => f.store.clear(), /元ファイルを保護/u)
    assert.equal(fs.readFileSync(f.store.filePath, 'utf8'), '{bad json')
  } finally { f.close() }
  const f2 = fixture()
  try {
    const base = f2.store.fs
    f2.store.fs = { ...base, renameSync() { throw new Error('simulated rename failure') } }
    assert.throws(() => f2.store.addManual({ type:'user_fact', content:'物理学を勉強している' }), /rename failure/u)
    assert.equal(fs.existsSync(f2.store.filePath), false)
    assert.equal(f2.store.list().length, 0)
  } finally { f2.close() }
  const f3 = fixture()
  try {
    fs.writeFileSync(f3.store.filePath, JSON.stringify({ version:1, items:[
      { id:'valid', type:'user_fact', status:'active', content:'物理学を勉強している' },
      { id:'partial-corrupt', type:'unknown', status:'invalid', content:'壊れた行' },
    ] }))
    const original = fs.readFileSync(f3.store.filePath, 'utf8')
    f3.store.load()
    assert.equal(f3.store.status().writable, false)
    assert.throws(() => f3.store.clear(), /元ファイルを保護/u)
    assert.equal(fs.readFileSync(f3.store.filePath, 'utf8'), original)
  } finally { f3.close() }
})

test('大量記憶でも検索結果は小さく制限される', () => {
  const f = fixture({ maxItems:2000 })
  try {
    const timestamp = new Date().toISOString()
    const records = Array.from({ length:1200 }, (_, i) => ({ id:`memory-${i}`, type:'user_fact', content:`関心分野 ${i} は電磁気学の勉強`,
      sourceConversationId:null, sourceMessageId:`${i}`, sourceType:'manual', createdAt:timestamp, updatedAt:timestamp,
      confidence:1, confirmed:true, expiresAt:null, status:'active', groupKey:null, sensitive:false, replacesId:null }))
    fs.writeFileSync(f.store.filePath, JSON.stringify({ version:1, items:records }))
    f.store.load()
    const started = performance.now()
    const result = f.store.searchRelevant('電磁気学 勉強', { maxItems:3, maxChars:900 })
    const elapsedMs = performance.now() - started
    assert.ok(result.length <= 3)
    assert.ok(elapsedMs < 1000, `検索に ${elapsedMs.toFixed(1)}ms かかりました`)
  } finally { f.close() }
})
