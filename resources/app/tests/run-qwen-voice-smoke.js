'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DEFAULT_SETTINGS, saveSettings } = require('../src/core/config')

const bundleRoot = path.resolve(__dirname, '..', '..', '..')
const appExecutable = path.join(bundleRoot, 'DeepSeekちゃん.exe')
const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-qwen-smoke-'))
const userData = path.join(qaRoot, 'user-data')
fs.mkdirSync(userData, { recursive: true })
const settings = structuredClone(DEFAULT_SETTINGS)
settings.features.live2dNaturalIdle = true
settings.features.emotionPersistence = true
settings.features.lowLatencySpeech = true
settings.features.instantReaction = true
settings.features.adaptiveVoiceResponse = true
settings.features.silentReactions = true
settings.avatar.mode = 'live2d'
settings.voice.enabled = true
settings.voice.engine = 'qwen3'
settings.qwen.mode = 'local'
settings.qwen.serverUrl = 'http://127.0.0.1:8765'
saveSettings(path.join(userData, 'settings.json'), settings)

const inherited = ['PATH','SystemRoot','WINDIR','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','HOMEDRIVE','HOMEPATH','COMSPEC']
const env = Object.fromEntries(inherited.filter(key => process.env[key]).map(key => [key, process.env[key]]))
const resultPath = path.join(userData, 'qwen-voice-smoke.json')
const screenshotPath = path.join(userData, 'qwen-voice-smoke.png')
Object.assign(env, {
  DEEPSEEK_QA_DATA: userData,
  DEEPSEEK_API_KEY: '',
  DASHSCOPE_API_KEY: '',
  DEEPSEEK_SKIP_QWEN: '1',
  DEEPSEEK_CHAN_SMOKE: '1',
  DEEPSEEK_CHAN_SMOKE_VOICE: '1',
  DEEPSEEK_CHAN_SMOKE_RESULT: resultPath,
  DEEPSEEK_CHAN_SMOKE_SHOT: screenshotPath,
})

async function main() {
  assert.ok(fs.existsSync(appExecutable), `Packaged Electron executable not found: ${appExecutable}`)
  const result = await new Promise((resolve, reject) => {
    const child = spawn(appExecutable, [], { cwd: bundleRoot, env, windowsHide: true, stdio: 'ignore' })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Qwen voice smoke timed out')) }, 90000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => {
      clearTimeout(timeout)
      try {
        assert.equal(code, 0, `Voice smoke exited with code ${code}`)
        resolve(JSON.parse(fs.readFileSync(resultPath, 'utf8')))
      } catch (error) { reject(error) }
    })
  })
  assert.equal(result.voiceServiceAvailable, true)
  assert.ok(result.pcmChunks > 0 && result.maxPcm > 0, 'Qwen did not return PCM audio')
  assert.ok(result.firstPlaybackSeconds > 0, 'Audio playback did not start')
  assert.equal(result.outcome, 'AbortError', 'Interrupted Qwen playback should end as AbortError')
  assert.equal(result.speakingBeforeInterrupt, true)
  assert.equal(result.speakingAfterInterrupt, false)
  assert.equal(result.mouthAfterInterrupt, 0)
  assert.equal(result.activeGenerationCleared, true)
  assert.equal(result.instantListening, true)
  assert.equal(result.adaptiveSelectionCorrect, true)
  assert.equal(result.DeepSeekApiCalled, false)
  process.stdout.write(JSON.stringify({ passed: true, ...result, screenshotPath,
    isolatedUserData: userData }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`Qwen voice smoke failed: ${error.stack || error}\n`)
  process.stderr.write(`Isolated user data retained at: ${userData}\n`)
  process.exitCode = 1
})
