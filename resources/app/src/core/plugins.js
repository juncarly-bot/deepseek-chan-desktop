'use strict'
/**
 * plugins.js — 拡張プラグイン基盤（必須機能8: 拡張性）
 *
 * プラグインは { id, name, description, setup(api) } を export する JS ファイル。
 * api が提供するもの:
 *   api.on(event, handler)   'messageReceived' | 'replySent' | 'idle' | 'started'
 *   api.say(text)            キャラクターに発話させる（TTS + 口パクは表示側が行う）
 *   api.generateIdle(hint)   DeepSeek で自発発話の文を生成する
 *   api.getSettings()        現在の設定（読み取り専用のつもりで扱う）
 *   api.log(...args)         ログ出力
 *
 * 将来の「アプリ操作」などは、ここに api.doAction(name, args) のような
 * 汎用アクションを追加して拡張する想定。
 */
const fs = require('fs')
const path = require('path')

class PluginHost {
  constructor(api) {
    this.api = api
    this.plugins = []
    this.handlers = new Map()
    const baseOn = (event, handler) => {
      if (!this.handlers.has(event)) this.handlers.set(event, [])
      this.handlers.get(event).push(handler)
    }
    this.pluginApi = { ...api, on: baseOn }
  }

  register(plugin) {
    if (!plugin || !plugin.id || typeof plugin.setup !== 'function') {
      throw new Error('プラグイン形式が不正です: { id, name, setup(api) } が必要です')
    }
    plugin.setup(this.pluginApi)
    this.plugins.push({ id: plugin.id, name: plugin.name || plugin.id, description: plugin.description || '' })
    return plugin
  }

  /** ディレクトリ内の .js をすべてプラグインとして読み込む（index.js と *.test.js は除く） */
  loadFromDir(dir) {
    if (!fs.existsSync(dir)) return []
    const loaded = []
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.js') || name === 'index.js' || name.endsWith('.test.js')) continue
      const plugin = require(path.join(dir, name))
      this.register(plugin)
      loaded.push(plugin.id)
    }
    return loaded
  }

  async emit(event, payload) {
    for (const h of this.handlers.get(event) || []) {
      try {
        await h(payload)
      } catch (e) {
        this.api.log?.(`[plugin] ${event} ハンドラでエラー: ${e.message}`)
      }
    }
  }

  list() {
    return [...this.plugins]
  }
}

module.exports = { PluginHost }
