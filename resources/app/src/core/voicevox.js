'use strict'
/**
 * voicevox.js — VOICEVOX ENGINE クライアント
 *
 * VOICEVOX（アプリ版 / ENGINE版）が http://127.0.0.1:50021 で提供する
 * ローカル REST API を使う。AITuberKit の /api/tts-voicevox と同じ手順:
 *   1. POST /audio_query?speaker=<id>&text=<text>  → 音声クエリ(JSON)
 *   2. クエリに speedScale 等を上書き
 *   3. POST /synthesis?speaker=<id> (body=クエリ) → audio/wav
 *
 * VOICEVOX 本体は別途インストール・起動が必要（無料）。
 * 話者IDは /speakers から動的に取得できるので、設定画面で一覧から選べる。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:50021'
// 既定の話者: 春日部つむぎ（ノーマル）。明るく可愛い声で DeepSeekちゃんの既定値とする。
// 設定画面で /speakers の一覧からいつでも変更可能。
const DEFAULT_SPEAKER = 8

class VoicevoxError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'VoicevoxError'
    this.status = status || 0
  }
}

function createVoicevoxClient(options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new VoicevoxError('fetch が利用できません')
  }

  /** VOICEVOX が起動しているか。起動していなければ false（例外にしない） */
  async function isAvailable() {
    try {
      const res = await fetchImpl(`${baseUrl}/version`)
      return res.ok
    } catch {
      return false
    }
  }

  /** 話者一覧を [{ uuid, speakerName, styleId, styleName, label }] に平坦化して返す */
  async function speakers() {
    const res = await fetchImpl(`${baseUrl}/speakers`)
    if (!res.ok) throw new VoicevoxError(`VOICEVOX /speakers エラー (${res.status})`, res.status)
    const list = await res.json()
    const flat = []
    for (const sp of list || []) {
      for (const st of sp.styles || []) {
        flat.push({
          uuid: sp.speaker_uuid,
          speakerName: sp.name,
          styleId: st.id,
          styleName: st.name,
          label: `${sp.name}（${st.name}）`,
        })
      }
    }
    return flat
  }

  /** 音声クエリを作る（synthesize の前段。テスト用にも公開） */
  async function audioQuery(text, speaker) {
    const url = `${baseUrl}/audio_query?speaker=${encodeURIComponent(speaker)}&text=${encodeURIComponent(text)}`
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    if (!res.ok) throw new VoicevoxError(`VOICEVOX audio_query エラー (${res.status})`, res.status)
    return res.json()
  }

  /**
   * テキストを wav 化する。
   * @returns {Promise<ArrayBuffer>} audio/wav
   */
  async function synthesize(text, opts = {}) {
    const speaker = opts.speaker ?? DEFAULT_SPEAKER
    const query = await audioQuery(text, speaker)
    if (typeof opts.speedScale === 'number') query.speedScale = opts.speedScale
    if (typeof opts.pitchScale === 'number') query.pitchScale = opts.pitchScale
    if (typeof opts.intonationScale === 'number') query.intonationScale = opts.intonationScale
    if (typeof opts.volumeScale === 'number') query.volumeScale = opts.volumeScale
    const res = await fetchImpl(`${baseUrl}/synthesis?speaker=${encodeURIComponent(speaker)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify(query),
    })
    if (!res.ok) throw new VoicevoxError(`VOICEVOX synthesis エラー (${res.status})`, res.status)
    return res.arrayBuffer()
  }

  return { isAvailable, speakers, audioQuery, synthesize, baseUrl }
}

module.exports = { DEFAULT_BASE_URL, DEFAULT_SPEAKER, VoicevoxError, createVoicevoxClient }
