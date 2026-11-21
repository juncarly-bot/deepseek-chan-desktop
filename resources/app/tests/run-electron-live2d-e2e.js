'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DEFAULT_SETTINGS, saveSettings } = require('../src/core/config')

const bundleRoot = path.resolve(__dirname, '..', '..', '..')
const appExecutable = path.join(bundleRoot, 'DeepSeekちゃん.exe')
const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-chan-electron-e2e-'))
const userData = path.join(qaRoot, 'user-data')
fs.mkdirSync(userData, { recursive: true })

const isolatedSettings = structuredClone(DEFAULT_SETTINGS)
isolatedSettings.features.live2dNaturalIdle = false
isolatedSettings.avatar.mode = 'live2d'
isolatedSettings.qwen.mode = 'local'
isolatedSettings.qwen.serverUrl = 'http://127.0.0.1:1'
saveSettings(path.join(userData, 'settings.json'), isolatedSettings)

const inheritedKeys = ['PATH','SystemRoot','WINDIR','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','HOMEDRIVE','HOMEPATH','COMSPEC']
const cleanEnv = Object.fromEntries(inheritedKeys.filter(key => process.env[key]).map(key => [key, process.env[key]]))
Object.assign(cleanEnv, {
  DEEPSEEK_QA_DATA: userData,
  DEEPSEEK_E2E: '1',
  DEEPSEEK_E2E_CHAT: '1',
  DEEPSEEK_E2E_PCM: '1',
  DEEPSEEK_E2E_AUTONOMY: '1',
  DEEPSEEK_E2E_DESKTOP: '1',
  DEEPSEEK_E2E_FOLLOWUPS: '1',
  DEEPSEEK_E2E_CALENDAR: '1',
  DEEPSEEK_SKIP_QWEN: '1',
  DEEPSEEK_API_KEY: '',
  DASHSCOPE_API_KEY: '',
})

function runStage(stage) {
  const resultPath = path.join(userData, `e2e-${stage}.json`)
  const env = { ...cleanEnv, DEEPSEEK_E2E_STAGE: stage, DEEPSEEK_E2E_RESULT: resultPath }
  return new Promise((resolve, reject) => {
    const child = spawn(appExecutable, [], { cwd: bundleRoot, env, windowsHide: true, stdio: 'ignore' })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Electron E2E stage timed out: ${stage}`))
    }, 90000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      try {
        assert.equal(code, 0, `Electron E2E stage ${stage} exited with code=${code} signal=${signal}`)
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
        resolve(result)
      } catch (error) { reject(error) }
    })
  })
}

async function main() {
  assert.ok(fs.existsSync(appExecutable), `Packaged Electron executable not found: ${appExecutable}`)
  const stages = []
  const fullStageList = ['save-on','restore-on-disable','restore-off','adaptive','silent','arbitration','memory','memory-restore','followup','followup-restore','calendar','calendar-restore','calendar-presence']
  const selectedStages = process.env.DEEPSEEK_E2E_STAGES
    ? process.env.DEEPSEEK_E2E_STAGES.split(',').map(value => value.trim()).filter(value => fullStageList.includes(value))
    : fullStageList
  if (!selectedStages.length) throw new Error('No recognized E2E stages selected')
  for (const stage of selectedStages) {
    if (stage === 'memory') fs.writeFileSync(path.join(userData, 'chat-history.json'), JSON.stringify([
      { id:'memory-e2e-user-1', role:'user', content:'物理学を勉強している。来週、電磁気学の試験があるんだ', ts:new Date().toISOString() },
      { id:'memory-e2e-assistant-1', role:'assistant', content:'応援しているよ', ts:new Date().toISOString() },
      { id:'memory-e2e-user-2', role:'user', content:'もし数学を勉強していたら、という仮定だよ', ts:new Date().toISOString() },
    ], null, 2), 'utf8')
    stages.push(await runStage(stage))
  }
  const byStage = new Map(stages.map(stage => [stage.stage, stage]))
  if (byStage.has('save-on')) assert.equal(byStage.get('save-on').defaultOff, true)
  if (byStage.has('restore-on-disable')) {
    assert.equal(byStage.get('restore-on-disable').restoredOn, true)
    assert.equal(byStage.get('restore-on-disable').settingsSavedOff, true)
  }
  if (byStage.has('restore-off')) assert.equal(byStage.get('restore-off').restoredOff, true)
  for (const [stage, flag] of [['adaptive','adaptivePassed'],['silent','silentPassed'],['arbitration','arbitrationPassed'],
    ['memory','memoryPassed'],['memory-restore','memoryRestoredPassed'],['followup','followUpPassed'],['followup-restore','followUpRestoredPassed'],
    ['calendar','calendarPassed'],['calendar-restore','calendarRestoredPassed'],['calendar-presence','calendarPresencePassed']]) {
    if (byStage.has(stage)) assert.equal(byStage.get(stage)[flag], true)
  }
  assert.ok(stages.every(result => result.externalApiCalled === false && result.realQwenAudioPlayed === false))
  process.stdout.write(JSON.stringify({ passed: true, stages, isolatedUserData: userData }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`Electron Live2D E2E failed: ${error.stack || error}\n`)
  process.stderr.write(`Isolated user data retained at: ${userData}\n`)
  process.exitCode = 1
})
