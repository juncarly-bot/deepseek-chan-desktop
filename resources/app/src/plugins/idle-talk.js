'use strict'
/**
 * idle-talk プラグイン（サンプル兼実機能）
 *
 * 一定時間会話がないときに、DeepSeekちゃんから自発的に一言話しかける。
 * 有効/無効と間隔は設定（idleTalk.enabled / idleTalk.intervalMinutes）で制御し、
 * 実際のタイマーはホスト（Electron メインプロセス）が回して 'idle' イベントを発火する。
 * AI生成に失敗した場合は定型文にフォールバックする。
 */

const FALLBACK_LINES = [
  '[relaxed]ねえねえ、最近なにか面白いことあった？',
  '[happy]ちょっと休憩しない？　水分補給だいじだよ。',
  '[neutral][motion:think]そういえば、今日の調子はどう？',
  '[happy][motion:wave]わたしはいつでもここにいるから、話したくなったら声かけてね。',
]

module.exports = {
  id: 'idle-talk',
  name: '自発発話（アイドルトーク）',
  description: '会話が途切れたときに DeepSeekちゃんから話しかけるプラグイン。',
  setup(api) {
    const recentLines = []
    const normalize = text => String(text || '').replace(/[\s。、！？!?.,…「」『』]/g, '').toLowerCase()
    const rememberAndCheck = text => {
      const key = normalize(text)
      if (!key || recentLines.includes(key)) return false
      recentLines.push(key)
      while (recentLines.length > 5) recentLines.shift()
      return true
    }
    const fallbackLine = () => {
      const { parseEmotionTags, cleanText } = require('../core/parser')
      const available = FALLBACK_LINES
        .map(line => ({ line, text: cleanText(line) }))
        .filter(item => !recentLines.includes(normalize(item.text)))
      if (!available.length) return null
      const selected = available[Math.floor(Math.random() * available.length)]
      rememberAndCheck(selected.text)
      return { text:selected.text, segments:parseEmotionTags(selected.line) }
    }

    api.on('idle', async payload => {
      const settings = api.getSettings()
      if (!settings.idleTalk?.enabled) return
      const signal = payload?.signal
      if (signal?.aborted) return
      try {
        const line = await api.generateIdle(undefined, { signal })
        if (signal?.aborted) return
        if (line?.plainText && rememberAndCheck(line.plainText)) {
          api.say(line.plainText, line.segments, { signal })
          return
        }
      } catch (e) {
        if (signal?.aborted) return
        api.log(`[idle-talk] AI生成に失敗、定型文を使います: ${e.message}`)
      }
      if (signal?.aborted) return
      const line = fallbackLine()
      if (line) api.say(line.text, line.segments, { signal })
    })

    api.on('autonomyAction', payload => {
      const settings = api.getSettings()
      if (!settings.autonomy?.actionsEnabled || payload?.signal?.aborted) return
      if (typeof payload?.action === 'string') api.act?.(payload.action)
    })
  },
}
