'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { PluginHost } = require('../src/core/plugins')

function makeHost({ enabled, generateIdle }) {
  const said = []
  const host = new PluginHost({
    log: () => {},
    getSettings: () => ({ idleTalk: { enabled } }),
    generateIdle,
    say: (text, segments) => said.push({ text, segments }),
  })
  return { host, said }
}

test('プラグインディレクトリから idle-talk が読み込める', async () => {
  const { host } = makeHost({ enabled: false, generateIdle: async () => null })
  const loaded = host.loadFromDir(path.join(__dirname, '..', 'src', 'plugins'))
  assert.deepStrictEqual(loaded, ['idle-talk'])
  assert.strictEqual(host.list()[0].id, 'idle-talk')
})

test('idle-talk: 無効時は発話しない', async () => {
  const { host, said } = makeHost({ enabled: false, generateIdle: async () => ({ plainText: 'x', segments: [] }) })
  host.loadFromDir(path.join(__dirname, '..', 'src', 'plugins'))
  await host.emit('idle', {})
  assert.strictEqual(said.length, 0)
})

test('idle-talk: 有効時はAI生成の一言を発話する', async () => {
  const { host, said } = makeHost({
    enabled: true,
    generateIdle: async () => ({ plainText: 'ねえ、元気？', segments: [{ emotion: 'happy', motion: null, text: 'ねえ、元気？' }] }),
  })
  host.loadFromDir(path.join(__dirname, '..', 'src', 'plugins'))
  await host.emit('idle', {})
  assert.strictEqual(said.length, 1)
  assert.strictEqual(said[0].text, 'ねえ、元気？')
})

test('idle-talk: AI生成が失敗したら定型文にフォールバックする', async () => {
  const { host, said } = makeHost({
    enabled: true,
    generateIdle: async () => { throw new Error('API down') },
  })
  host.loadFromDir(path.join(__dirname, '..', 'src', 'plugins'))
  await host.emit('idle', {})
  assert.strictEqual(said.length, 1)
  assert.ok(said[0].text.length > 0)
  assert.ok(!said[0].text.includes('[')) // タグ除去済み
})

test('idle-talk: 直近と同じ独り言を繰り返さず、API呼び出しを再試行しない', async () => {
  let generated = 0
  const { host, said } = makeHost({ enabled:true, generateIdle:async () => {
    generated++
    return { plainText:'同じ一言だよ。', segments:[{ emotion:'neutral', text:'同じ一言だよ。' }] }
  } })
  host.loadFromDir(path.join(__dirname, '..', 'src', 'plugins'))
  await host.emit('idle', {})
  await host.emit('idle', {})
  assert.equal(generated, 2)
  assert.equal(said.length, 2)
  assert.notEqual(said[0].text, said[1].text)
})

test('idle-talk: 生成中に中断された独り言は発話しない', async () => {
  let release
  const { host, said } = makeHost({ enabled:true, generateIdle:async () => new Promise(resolve => { release = resolve }) })
  host.loadFromDir(path.join(__dirname, '..', 'src', 'plugins'))
  const controller = new AbortController()
  const task = host.emit('idle', { signal:controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  release({ plainText:'遅れて届いた独り言。', segments:[] })
  await task
  assert.equal(said.length, 0)
})

test('不正なプラグインは登録時にエラーになる', () => {
  const { host } = makeHost({ enabled: false, generateIdle: async () => null })
  assert.throws(() => host.register({ name: 'x' }), /プラグイン形式が不正/)
})
