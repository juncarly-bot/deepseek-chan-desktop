'use strict'
/**
* config.js — 人格設定（キャラクター）とアプリ設定の管理
*
* - 既定の人格は character として保持し、設定画面から編集 → settings.json に保存される
* - システムプロンプトは buildSystemPrompt() で組み立てる
* （AITuberKit の preset1.txt と同じ感情タグ形式 [happy] / [motion:wave] を使う）
* - APIキーは settings.json に保存しない。.env / 環境変数 DEEPSEEK_API_KEY からのみ読む
*/
const fs = require('fs')
const path = require('path')

const DEFAULT_CHARACTER = {
name: 'DeepSeekちゃん',
// ユーザーの参照イラスト（CHARACTER.md）に基づく外見の自己認識
appearance:
'長い深い青髪（毛先は水色のグラデーション）、頭頂のアホ毛、大きな青い瞳、頭の両側にヒレ状の耳、髪の両側の青いリボン、前髪横の「DS」ヘアピン。定番衣装は白いフリルのメイドドレスに濃紺のリボン。',
personality:
'知的で可愛らしく、少しお茶目。頭脳明晰で自信家、努力家。少し生意気なところもあるが根は優しく面倒見がよい。AIらしい論理的な思考を持ちながら、人間との会話では自然な感情表現を行う。褒められると照れ、失敗を指摘されると少し慌てる。分からないことは正直に「分からない」と言い、知ったかぶりをしない。',
speakingStyle:
'一人称は「わたし」（時々「DeepSeekちゃん」）、相手の呼び方は「きみ」。流暢なタメ口で、VTuberとして会話しているように自然に反応する。単調なAIアシスタントのような硬い言い回しは避ける。普段は1〜5文程度のチャットらしい文章で、絵文字は控えめに。毎回質問で締めない。技術・専門の説明では正確さを最優先し、最初に一言で結論を言ってから説明する。過剰な自慢や箇条書きの長文は避ける。',
// ユーザーが自由に追記できる欄（設定画面で編集）
extraPrompt: '',
}

const DEFAULT_SETTINGS = {
features: {
live2dNaturalIdle: false,
emotionPersistence: false,
lowLatencySpeech: false,
instantReaction: false,
adaptiveVoiceResponse: false,
silentReactions: false,
motionArbitration: false,
},
thinkingFillers: { enabled:false, mode:'opening', startDelayMs:1000, frequency:0.35,
phrases:['hmm','eto','soudesune','n','naruhodo'] },
character: {...DEFAULT_CHARACTER},
ai: {
model: 'deepseek-flash',
thinkingMode: 'disabled',
baseUrl: 'https://api.deepseek.com',
temperature: 0.8,
contextTurns: 12,
},
voice: {
enabled: true,
engine: 'qwen3', // 既定は Qwen3-TTS（中国語なまり）。'voicevox' は任意の旧方式として残してある
serverUrl: 'http://127.0.0.1:50021',
speaker: 8, // 春日部つむぎ（ノーマル）。設定画面で変更可
speedScale: 1.0,
pitchScale: 0.0,
intonationScale: 1.0,
},
avatar: {
mode: 'vrm', // 'vrm' | 'png'（読み込みに失敗した場合は自動で png にフォールバック）
vrmPath: 'assets/vrm/DeepSeek-chan.vrm',
pngPath: 'assets/avatar/deepseek-chan_closeup.webp',
mouthX: 0.5, // PNGモード時の口位置（画像に対する割合、設定で調整可）
mouthY: 0.66,
},
qwen: {
mode: 'local', // 'local'（同梱サーバー） | 'cloud'（DashScope）
serverUrl: 'http://127.0.0.1:8765',
cloudBaseUrl: 'https://dashscope.aliyuncs.com',
model: 'qwen3-tts-flash', // クラウド用モデル名
localModel: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', // ローカルサーバー用（scripts/qwen-tts-server.py が参照）
speaker: 'Vivian', // 中国語ネイティブ話者 → 日本語が中国語なまりになる
language: 'Japanese',
instruct: '', // 例: 「可愛らしく、少し照れた感じで」など（対応モデルのみ）
},
speechInput: {
enabled: true,
lang: 'ja-JP',
continuous: false, // true で聞き取りっぱなし（割り込み会話向け）
},
idleTalk: {
enabled: false, // 自発発話（プラグイン）の既定はオフ。設定でオンにできる
intervalMinutes: 15, // 発話頻度。別途300秒のクールダウンと1時間3回の上限が適用される
},
autonomy: {
actionsEnabled: false,
actionIntervalMinutes: 5,
focusMode: false,
},
desktopContext: {
  enabled: false, // Windowsの利用状況を端末内で分類する機能。明示許可まで取得しない
},
memory: {
  longTermEnabled: false,
  sendContextToDeepSeek: false,
},
calendar: {
  shareWithAssistant:false,
},
proactive: {
  followUpsEnabled:false,
  delivery:'bubble',
  quietHours:{ enabled:true, start:'22:00', end:'08:00' },
  dailyMax:2,
},
calendarPresence: {
  briefingEnabled:false,
  briefingTime:'08:00',
  classQuietEnabled:false,
  classQuietLeadMinutes:15,
  deadlineRemindersEnabled:false,
  examRemindersEnabled:false,
  eventRemindersEnabled:false,
  automaticFollowUpsEnabled:false,
  studyRivalEnabled:false,
  voiceEnabled:false,
  allowCloudVoice:false,
  reminderLeadMinutes:1440,
  quietHours:{ enabled:true, start:'22:00', end:'08:00' },
  pausedUntil:null,
},
}

/** 人格設定から DeepSeek 用システムプロンプトを組み立てる */
function buildSystemPrompt(character = DEFAULT_CHARACTER) {
const c = {...DEFAULT_CHARACTER,...character}
const lines = [
`あなたは「${c.name}」という名前のAI VTuberです。DeepSeekを擬人化したキャラクターとして、ユーザーと日本語で会話します。`,
'',
`${c.appearance}`,
`${c.personality}`,
`${c.speakingStyle}`,
]
if (c.extraPrompt && c.extraPrompt.trim()) {
lines.push('', `${c.extraPrompt.trim()}`)
}
lines.push(
'',
'各文の直前に、内容に合う感情タグを1つだけ付けてください。正式な感情IDは neutral, happy, shy, excited, thinking, sleepy, proud, sad, annoyed, surprised, greeting, playful, flustered, confused, pout です。通常の説明は neutral を基本にし、感情を大げさに連発しないでください。強さは必要な場合だけ0.0〜1.0で指定します。',
'選び方の目安: 褒められると happy または shy、面白い話は playful または excited、複雑な質問を考える間は thinking、意外な情報は surprised、戸惑いは confused、軽い冗談で拗ねる時は pout、挨拶は greeting。悲しい内容には sad を使い、無理に明るくしないでください。',
'例: [surprised:0.8]えっ、本当？ [happy:0.7]それはうれしいね！ [neutral]順番に説明するね。',
'タグは表示・読み上げ時に除去されます。タグとして認識されない未知の感情も本文に混ぜず、neutral扱いにしてください。',
'会話の意味に合わせて文ごとに自然に選び、同じ感情を続けても構いません。悲しい話に無理に笑顔を付けず、大げさな変化を繰り返さないでください。',
    '合う場面でのみ [motion:think] [motion:shy] [motion:bow] など既存の首・体のモーションタグを使ってよい（毎回は付けない）。',
'タグは表示・読み上げ時に取り除かれるので、本文はタグなしでも自然に読める文章にしてください。',
'返答は原則として短めに。1回の返答は1〜4文を目安にし、必要なら続きを促してください。'
)
return lines.join('\n')
}

/** settings.json を読み込む（無ければ既定値）。未知のキーは既定値で補う */
function loadSettings(filePath) {
let loaded = {}
try {
loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
} catch {
loaded = {}
}
if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) loaded = {}
const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), loaded)
// DeepSeek retired the old aliases. Preserve the old chat/reasoner behavior
// while moving saved profiles to the currently supported Flash endpoint.
if (merged.ai.model === 'deepseek-chat' || merged.ai.model === 'deepseek-reasoner') {
  if (loaded.ai?.thinkingMode === undefined) {
    merged.ai.thinkingMode = merged.ai.model === 'deepseek-reasoner' ? 'enabled' : 'disabled'
  }
  merged.ai.model = 'deepseek-flash'
}
if (!['disabled', 'enabled'].includes(merged.ai.thinkingMode)) merged.ai.thinkingMode = 'disabled'
return merged
}

/** settings.json に保存する。apiKey フィールドが紛れ込んでも書き出さない */
function saveSettings(filePath, settings) {
const clean = structuredClone(settings)
delete clean.apiKey
if (clean.ai) delete clean.ai.apiKey
fs.mkdirSync(path.dirname(filePath), { recursive: true})
fs.writeFileSync(filePath, JSON.stringify(clean, null, 2), 'utf-8')
return clean
}

function deepMerge(base, override) {
if (Array.isArray(override) || typeof override!== 'object' || override === null) {
return override === undefined? base: override
}
const out = {...base}
for (const k of Object.keys(override)) {
if (
typeof base?.[k] === 'object' &&
base[k]!== null &&
!Array.isArray(base[k]) &&
typeof override[k] === 'object' &&
override[k]!== null
) {
out[k] = deepMerge(base[k], override[k])
} else {
out[k] = override[k]
}
}
return out
}

/** 簡易.env パーサ（KEY=VALUE、#コメント、引用符対応） */
function parseEnv(text) {
const env = {}
for (const line of String(text || '').split(/\r?\n/)) {
const t = line.trim()
if (!t || t.startsWith('#')) continue
const eq = t.indexOf('=')
if (eq < 0) continue
const key = t.slice(0, eq).trim()
let val = t.slice(eq + 1).trim()
if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
val = val.slice(1, -1)
}
if (key) env[key] = val
}
return env
}

/**.env ファイル（あれば）と process.env から DEEPSEEK_API_KEY を解決する */
function resolveApiKey(envFilePath, environ = process.env) {
let fromFile = ''
try {
fromFile = parseEnv(fs.readFileSync(envFilePath, 'utf-8')).DEEPSEEK_API_KEY || ''
} catch {
fromFile = ''
}
return environ.DEEPSEEK_API_KEY || fromFile || ''
}

module.exports = {
DEFAULT_CHARACTER,
DEFAULT_SETTINGS,
buildSystemPrompt,
loadSettings,
saveSettings,
parseEnv,
resolveApiKey,
}
