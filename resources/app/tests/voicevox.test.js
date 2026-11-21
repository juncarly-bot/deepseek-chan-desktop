'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createVoicevoxClient } = require('../src/core/voicevox')

function mockFetch(routes) {
  const calls = []
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' })
    if (String(url).includes('/version')) return { ok: true, json: async () => '0.25.0' }
    if (String(url).includes('/speakers')) {
      return {
        ok: true,
        json: async () => [
          { name: '春日部つむぎ', speaker_uuid: 'uuid-1', styles: [{ id: 8, name: 'ノーマル' }] },
          { name: 'ずんだもん', speaker_uuid: 'uuid-2', styles: [{ id: 3, name: 'ノーマル' }, { id: 1, name: 'あまあま' }] },
        ],
      }
    }
    if (String(url).includes('/audio_query')) {
      return { ok: true, json: async () => ({ speedScale: 1, pitchScale: 0, intonationScale: 1, kana: 'テスト' }) }
    }
    if (String(url).includes('/synthesis')) {
      // リクエストボディに speedScale の上書きが反映されているか確認できるよう保持
      fn.lastBody = JSON.parse(opts.body)
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('FAKEWAV').buffer }
    }
    return { ok: false, status: 404 }
  }
  fn.calls = calls
  return fn
}

test('isAvailable は /version で判定する', async () => {
  const vv = createVoicevoxClient({ fetchImpl: mockFetch() })
  assert.strictEqual(await vv.isAvailable(), true)
  const down = createVoicevoxClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.strictEqual(await down.isAvailable(), false)
})

test('speakers は話者×スタイルに平坦化される', async () => {
  const vv = createVoicevoxClient({ fetchImpl: mockFetch() })
  const list = await vv.speakers()
  assert.strictEqual(list.length, 3)
  assert.deepStrictEqual(list[0], {
    uuid: 'uuid-1',
    speakerName: '春日部つむぎ',
    styleId: 8,
    styleName: 'ノーマル',
    label: '春日部つむぎ（ノーマル）',
  })
})

test('synthesize は audio_query → synthesis の順で呼び、速度を上書きする', async () => {
  const fetchImpl = mockFetch()
  const vv = createVoicevoxClient({ fetchImpl })
  const wav = await vv.synthesize('こんにちは', { speaker: 8, speedScale: 1.2 })
  assert.strictEqual(new TextDecoder().decode(wav), 'FAKEWAV')
  const urls = fetchImpl.calls.map((c) => c.url)
  assert.ok(urls[0].includes('/audio_query?speaker=8'))
  assert.ok(urls[0].includes('text=' + encodeURIComponent('こんにちは')))
  assert.ok(urls[1].includes('/synthesis?speaker=8'))
  assert.strictEqual(fetchImpl.lastBody.speedScale, 1.2)
})
