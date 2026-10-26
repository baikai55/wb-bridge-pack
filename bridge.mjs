// WorkBuddy QQ 桥接 v4：QQ 官方机器人 <-> CodeBuddy CLI
// 按对话窗口独立会话/独立锁；语音全双工(MiMo TTS + 硅基流动ASR + silk转码)；图片收发(ViewImage识别/生图直传)
// v4：主人私聊常驻热窗口（stream-json stdin 喂消息，不再每条重开进程；进程死了自动 -r 续接重建）
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { encode as silkEncode, decode as silkDecode, isSilk, isWav } from 'silk-wasm'

const DIR = process.env.WB_DIR || path.dirname(new URL(import.meta.url).pathname)
const CLI_HOME = process.env.WB_HOME || os.homedir()
const CLI_CWD = process.env.WB_CWD || CLI_HOME
const SESS_DIR = process.env.WB_SESS_DIR || path.join(CLI_HOME, '.codebuddy', 'projects', path.basename(CLI_CWD))
const APPID = process.env.QQBOT_APPID
const SECRET = process.env.QQBOT_APP_SECRET
const API = 'https://api.bot.qq.com'
const OPENID_FILE = process.env.QQ_OPENID_FILE || DIR + '/owner-openid.txt'
let OWNER = ''
try { OWNER = fs.readFileSync(OPENID_FILE, 'utf8').trim() } catch {}
if (!OWNER) console.error('⚠️ 缺少主人 openid：请把 QQ 用户 openid 写入 ' + OPENID_FILE)
const CLI = process.env.WB_CLI || '/opt/node22/bin/codebuddy'
const CFG_FILE = DIR + '/bot-config.json'
const SESSIONS_FILE = DIR + '/bot-sessions.json'
const PANEL_PORT = Number(process.env.BOT_PANEL_PORT || 8791)
let PANEL_TOKEN = ''
try { PANEL_TOKEN = fs.readFileSync(DIR + '/panel-token.txt', 'utf8').trim() } catch {}
if (!PANEL_TOKEN) {
  PANEL_TOKEN = crypto.randomBytes(24).toString('hex')
  try { fs.writeFileSync(DIR + '/panel-token.txt', PANEL_TOKEN, { mode: 0o600 }) } catch {}
}

// 语音密钥（voice.env, 600权限；缺省时语音功能自动禁用）
const VENV = {}
try {
  for (const line of fs.readFileSync(DIR + '/voice.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) VENV[m[1]] = m[2].trim()
  }
} catch {}
const MIMO_KEY = VENV.MIMO_API_KEY || ''
const SF_KEY = VENV.SF_API_KEY || ''
const ASR_MODEL = VENV.ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall'
const TTS_MODEL = VENV.TTS_MODEL || 'mimo-v2.5-tts'
const TTS_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']

const MODELS = [
  'deepseek-v4.1-flash', 'deepseek-v4-pro', 'hy4-preview', 'hy3', 'hy3-x',
  'step-5-preview', 'space-bunny', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2',
  'glm-5.1', 'glm-5v-turbo', 'minimax-m3.1-flash', 'minimax-m3', 'minimax-m2.7',
  'kimi-k3.1-pro', 'kimi-k3-1', 'kimi-k2.8-preview', 'mimo-v2.6-pro',
]

// 动态模型表：从 CLI --help 的 "Currently supported: (...)" 解析（CLI 升级列表跟着变），缓存10分钟，失败用内置兜底
let cliModelsCache = { at: 0, list: null }
function cliModels() {
  if (cliModelsCache.list && Date.now() - cliModelsCache.at < 600000) return cliModelsCache.list
  try {
    const r = spawnSync(CLI, ['--help'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: CLI_HOME, LANG: 'zh_CN.UTF-8', TERM: 'xterm-256color', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }, cwd: CLI_CWD,
    })
    const m = String(r.stdout || '').match(/Currently supported: \(([^)]+)\)/)
    const list = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : null
    if (list && list.length) { cliModelsCache = { at: Date.now(), list }; return list }
  } catch {}
  return MODELS
}

const state = { startedAt: Date.now(), handled: 0, online: false, onlineSince: null, busyWins: 0 }
const logsBuf = []
function log(...a) {
  const line = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' ' + a.join(' ')
  console.log(line)
  logsBuf.push(line)
  if (logsBuf.length > 200) logsBuf.shift()
}

const MODE_LABEL = { chat: '纯聊天', ro: '只读管家', full: '全权管家' }

function loadCfg() {
  const base = { model: 'deepseek-v4.1-flash', persona: '', memory: true, mode: 'full', effort: 'max', voice: { reply: 'mirror', voice: '冰糖', style: '' } }
  try {
    const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    const cfg = { ...base, ...c, voice: { ...base.voice, ...(c.voice || {}) } }
    if (c.mode === undefined && c.agent !== undefined) cfg.mode = c.agent ? 'full' : 'chat'
    return cfg
  } catch { return base }
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)) }

// ---------- 按窗口会话表 ----------
function loadSessions() { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) } catch { return {} } }
function saveSessions(s) {
  try { fs.writeFileSync(SESSIONS_FILE + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(SESSIONS_FILE + '.tmp', SESSIONS_FILE) } catch (e) { log('会话表保存失败:', e.message) }
}
function getSession(chatKey) {
  const s = loadSessions()
  const e = s[chatKey]
  if (!e || !e.sid) return null
  return e.sid // 记忆永久保留，只随「新话题/清除记忆」手动重开
}
function setSession(chatKey, sid) {
  const s = loadSessions(); s[chatKey] = { sid, at: Date.now() }; saveSessions(s)
}
function touchSession(chatKey) {
  const s = loadSessions()
  if (s[chatKey]) { s[chatKey].at = Date.now(); saveSessions(s) }
}
function clearSession(chatKey) {
  const s = loadSessions(); const had = !!s[chatKey]; delete s[chatKey]; saveSessions(s); return had
}
function clearAllSessions() { saveSessions({}) }

// ---------- 按窗口独立锁（同窗口串行，跨窗口并行） ----------
const winLocks = new Map()
function withWin(chatKey, fn) {
  const prev = winLocks.get(chatKey) || Promise.resolve()
  const p = prev.catch(() => {}).then(fn)
  winLocks.set(chatKey, p)
  p.finally(() => { if (winLocks.get(chatKey) === p) winLocks.delete(chatKey) })
  return p
}

// ---------- QQ API ----------
let token = null
let tokenExp = 0
async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp) return token
  const r = await fetch(API + '/app/getAppAccessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APPID, clientSecret: SECRET }),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 120))
  token = j.access_token
  tokenExp = Date.now() + (Number(j.expires_in || 7200) - 300) * 1000
  return token
}

const seqMap = new Map()
async function postMsg(openid, body, opts = {}) {
  const t = await getToken()
  const url = opts.groupId ? `${API}/v2/groups/${opts.groupId}/messages` : `${API}/v2/users/${openid}/messages`
  const send = async (b) => (await fetch(url, {
    method: 'POST', headers: { Authorization: `QQBot ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })).json().catch(() => ({}))
  if (opts.msgId && !opts.groupId) {
    const n = (seqMap.get(opts.msgId) || 0) + 1
    seqMap.set(opts.msgId, n)
    if (seqMap.size > 200) seqMap.delete(seqMap.keys().next().value)
    const j = await send({ ...body, msg_id: opts.msgId, msg_seq: n })
    if (j.code === 0) return j
  }
  return send(body) // 主动消息（或被动失败降级）
}
async function replyText(openid, text, opts) { return postMsg(openid, { msg_type: 0, content: String(text).slice(0, 1800) }, opts) }
async function replyMedia(openid, fileInfo, opts) { return postMsg(openid, { msg_type: 7, media: { file_info: fileInfo } }, opts) }

// 富媒体上传（file_data 二进制直传，≤5MB，图片/语音足够）
async function uploadMedia(openid, opts, fileType, buf, fileName) {
  const t = await getToken()
  const url = opts.groupId ? `${API}/v2/groups/${opts.groupId}/files` : `${API}/v2/users/${openid}/files`
  const r = await fetch(url, {
    method: 'POST', headers: { Authorization: `QQBot ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_type: fileType, file_data: buf.toString('base64'), file_name: fileName }),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.file_info) throw new Error('上传失败: ' + JSON.stringify(j).slice(0, 200))
  return j.file_info
}

// ---------- MiMo TTS / 硅基流动 ASR / silk ----------
async function mimoTTS(text, voice, style) {
  const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST', timeout: 30000,
    headers: { Authorization: `Bearer ${MIMO_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      messages: [
        { role: 'user', content: style || '自然清晰地朗读' },
        { role: 'assistant', content: String(text).slice(0, 1500) },
      ],
      audio: { format: 'wav', voice: voice || '冰糖' },
    }),
  })
  const j = await r.json().catch(() => ({}))
  const b64 = j.choices?.[0]?.message?.audio?.data
  if (!b64) throw new Error('TTS失败: ' + JSON.stringify(j).slice(0, 200))
  return Buffer.from(b64, 'base64') // WAV
}
async function silkFromWav(wavBuf) {
  const { data } = await silkEncode(wavBuf, 0) // WAV 自动识别采样率并并单声道
  return Buffer.from(data)
}
function pcmToWav(pcm, sampleRate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}
async function silkToWav(silkBuf) {
  let lastErr = null
  for (const sr of [24000, 16000, 44100]) {
    try { const { data } = await silkDecode(silkBuf, sr); return pcmToWav(Buffer.from(data), sr) } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('silk解码失败')
}
async function sfASR(wavBuf) {
  const fd = new FormData()
  fd.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'voice.wav')
  fd.append('model', ASR_MODEL)
  const r = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
    method: 'POST', timeout: 30000, headers: { Authorization: `Bearer ${SF_KEY}` }, body: fd,
  })
  const j = await r.json().catch(() => ({}))
  if (!j.text) throw new Error('ASR失败: ' + JSON.stringify(j).slice(0, 200))
  return j.text.trim()
}

const WEB_HINT = '你可以自由联网（curl 等）查资料、找图片、爬网页，自主决定搜索策略。图片交付规范：从网上下载（或生成）的图片保存到 /home/ops/generated-images/，交付前先用 ViewImage 工具查看确认内容符合用户要求，然后在最终回复文本里写出该图的完整本地路径（系统会自动把它发给用户），不要贴远程网址。生成的图片右下角自带「AI生成 WORKBUDDY」水印（在底部约130px条带内）：交付前用一条命令直接裁掉底部即可（例：convert 原图 -gravity South -chop 0x130），裁完 ViewImage 确认一次就交付，不要反复尝试精确修补去水印。QQ聊天回复保持简短。'

// 只从最终回复文本里取图片路径（不扫输出流，避免捞到历史会话里的旧路径）
const RE_IMG = /(\/[^\s"'\u2019\\)]*generated-images\/[^\s"'\u2019\\)]+\.(?:png|jpe?g|webp))/g
function imgsFrom(ans) { return [...new Set([...String(ans).matchAll(RE_IMG)].map(m => m[1]))] }

// 输出流截断/内部JSON残骸识别（加宽版：关键字或高密度 "key": 模式）
const JUNK_KEY = /"(cwd|_meta|traceparent|traceId|baggage|parentId|sessionId|session_id|ModelId|modelId|toolResult|renderer|messageId|isSnapshotUpdate|snapshot|providerData|finishReason|toolUseResult)"\s*:/
function looksLikeJunk(t) {
  t = String(t)
  if (t.length <= 120) return false
  if (JUNK_KEY.test(t)) return true
  const keys = (t.match(/"[A-Za-z_][\w-]{2,}"\s*:/g) || []).length
  return keys >= 5 && /^[{["\s]/.test(t)
}

// 从会话文件尾部抢救最后一条助手文本（输出流截断/DSML残留时的兜底）
function recoverFromSession(sid) {
  if (!sid) return null
  try {
    const f = SESS_DIR + '/' + sid + '.jsonl'
    const st = fs.statSync(f)
    const len = Math.min(st.size, 300000)
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line || line[0] !== '{') continue
      let e = null
      try { e = JSON.parse(line) } catch { continue }
      const role = e.role || (e.message && e.message.role) || (e.type === 'assistant' ? 'assistant' : e.type)
      if (role !== 'assistant') continue
      let c = e.content || (e.message && e.message.content)
      if (!c) continue
      if (typeof c === 'string') { if (c.trim() && !c.includes('DSML')) return c.trim().slice(0, 4000); continue }
      if (Array.isArray(c)) {
        const t = c.filter(p => p && p.type === 'text' && p.text).map(p => p.text).join('\n').trim()
        if (t && !t.includes('DSML')) return t.slice(0, 4000)
      }
    }
  } catch {}
  return null
}

// ---------- CodeBuddy CLI：冷启（每条消息一个进程，群聊/降级用） ----------
function runCLI(prompt, sid, tools, model, effort) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json']
    if (tools) args.push('--tools', tools)
    else args.push('--tools', '')
    if (tools && tools !== '') args.push('--permission-mode', 'bypassPermissions')
    if (tools === 'default') args.push('--append-system-prompt', WEB_HINT)
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
    if (sid) args.push('-r', sid)
    const p = spawn(CLI, args, {
      env: { ...process.env, HOME: CLI_HOME, LANG: 'zh_CN.UTF-8', TERM: 'xterm-256color', USER: process.env.USER || os.userInfo().username, LOGNAME: process.env.LOGNAME || os.userInfo().username, SHELL: process.env.SHELL || '/bin/bash', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }, cwd: CLI_CWD,
    })
    let killed = false
    const timer = setTimeout(() => { killed = true; try { p.kill('SIGKILL') } catch {} }, tools ? 480000 : 180000)
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', () => {
      clearTimeout(timer)
      let arr = null, last = null
      try {
        const j = JSON.parse(out)
        if (Array.isArray(j)) { arr = j; last = j[j.length - 1] } else last = j
      } catch {}
      const newSid = (last && (last.session_id || last.sessionId)) || (out.match(/"session_id"\s*:\s*"([0-9a-f-]{8,64})"/i) || [])[1]
      const noSession = sid && /no conversation found/i.test(out + err)
      let ans = last && (last.result || last.content)
      // 数组尾部可能挂着快照类元素，从后往前找真正带正文的消息
      if (!ans && arr) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const e = arr[i]
          if (e && ((typeof e.result === 'string' && e.result) || (typeof e.content === 'string' && e.content))) { ans = e.result || e.content; break }
        }
      }
      if (!ans) {
        const m = [...out.matchAll(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].pop()
        if (m) { try { ans = JSON.parse('"' + m[1] + '"') } catch {} }
      }
      if (!ans && killed) ans = '⏱ 这单跑超时了，没等到最终结果。试试把任务拆小一点再发。'
      if (!ans) ans = String(err || out).slice(-400).trim() || '（CLI 无返回，请重试）'
      // 输出流截断护栏：绝不让 JSON 流残骸直达用户；先尝试从会话文件抢救真实回复
      if (looksLikeJunk(ans)) {
        log('输出流异常(len=' + out.length + ', killed=' + killed + '):', String(ans).slice(0, 70).replace(/\n/g, ' '))
        const rec = recoverFromSession(newSid || sid)
        if (rec) { ans = rec; log('已从会话文件抢救回复:', ans.slice(0, 60).replace(/\n/g, ' ')) }
        else ans = '⚠️ 这单的输出流中途截断了，没拿到正常回复。如果刚才有搜索/生成的图片，跟我说「把刚才那张发我」即可。'
      }
      resolve({ ans: String(ans), sid: newSid || null, noSession, imgs: imgsFrom(ans) })
    })
    p.on('error', (e) => { clearTimeout(timer); resolve({ ans: 'CLI 错误: ' + e.message, sid: null, noSession: false, imgs: [] }) })
  })
}

function toolsFor(mode, hasImage) {
  if (hasImage) return mode === 'full' ? 'default' : (mode === 'ro' ? 'Read,Grep,Glob,ViewImage' : 'ViewImage')
  if (mode === 'full') return 'default'
  if (mode === 'ro') return 'Read,Grep,Glob'
  return ''
}

// ---------- 常驻热窗口（主人私聊常开；群聊回完话保温、空闲自动关） ----------
// 每条消息不再重开进程重载上下文；进程意外死亡/参数变化 → 下一条消息自动用 -r 续接重建
const WARM_MAX_AGE_MS = 24 * 3600 * 1000   // 热进程最长寿命：到点换新（记忆通过 -r 无缝续接，防内存膨胀）
const WARM_STALL_MS = 30 * 60 * 1000       // 卡死保险丝：CLI 真死锁时重置窗口（不是业务限时，正常大活碰不到）
const GROUP_WARM_IDLE_MS = 5 * 60 * 1000   // 群聊热窗口空闲回收：回完话保温5分钟，之后自动关
const WARM_MAX_PROCS = 2                   // 热进程容量上限（每个约300MB）：群聊之间互相挤占，私聊永不挤
const warmProcs = new Map()                // chatKey -> w
let shuttingDown = false

function memAvailMB() {
  try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s*(\d+) kB/); return m ? Math.round(Number(m[1]) / 1024) : 9999 } catch { return 9999 }
}
function rssOf(pid) {
  try { const m = fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/VmRSS:\s*(\d+)/); return m ? Math.round(Number(m[1]) / 1024) : null } catch { return null }
}
function killWarm(chatKey) {
  const w = warmProcs.get(chatKey)
  if (!w) return
  warmProcs.delete(chatKey)
  try { w.proc.kill('SIGKILL') } catch {}
}
function killAllWarm() { for (const k of [...warmProcs.keys()]) killWarm(k) }

function spawnWarm(chatKey, sid, tools, model, effort) {
  const avail = memAvailMB()
  if (avail < 350) throw new Error('内存余量不足(' + avail + 'MB)，暂不保温')
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
    '--tools', tools, '--permission-mode', 'bypassPermissions']
  if (effort) args.push('--effort', effort)
  if (tools === 'default') args.push('--append-system-prompt', WEB_HINT)
  if (sid) args.push('-r', sid, '--resume-create-missing')
  log('热窗口启动:', chatKey.slice(0, 12), `模型 ${model} 工具 ${tools === 'default' ? '全开' : tools || '无'} 思考 ${effort || '默认'}`, sid ? `续接 ${sid.slice(0, 8)}` : '新会话')
  const proc = spawn(CLI, args, {
    env: { ...process.env, HOME: CLI_HOME, LANG: 'zh_CN.UTF-8', TERM: 'xterm-256color', USER: process.env.USER || os.userInfo().username, LOGNAME: process.env.LOGNAME || os.userInfo().username, SHELL: process.env.SHELL || '/bin/bash', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }, cwd: CLI_CWD,
  })
  const w = { proc, chatKey, sid: sid || null, buf: '', results: 0, dead: false, bornAt: Date.now(), lastAt: Date.now(), key: JSON.stringify({ t: tools, m: model, e: effort || '' }), onResult: null }
  proc.stdout.on('data', (d) => {
    w.buf += d
    let i
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1)
      if (!line.trim()) continue
      let j = null
      try { j = JSON.parse(line) } catch { continue }
      if (j.type === 'result') {
        w.results++
        if (j.session_id && j.session_id !== w.sid) { w.sid = j.session_id; setSession(chatKey, w.sid) }
        if (w.onResult) { const fn = w.onResult; w.onResult = null; fn(j) }
      } else if ((j.type === 'system' || j.type === 'init') && j.session_id && !w.sid) {
        w.sid = j.session_id; setSession(chatKey, w.sid)
      }
    }
  })
  proc.stderr.on('data', (d) => { const s = String(d); if (/error|fail/i.test(s)) log('热窗口stderr:', s.slice(0, 150).trim()) })
  proc.on('close', (code) => {
    w.dead = true
    warmProcs.delete(chatKey)
    if (!shuttingDown) log('热窗口退出(code=' + code + '):', chatKey.slice(0, 12), '→ 下条消息将自动续接重建')
    if (w.onResult) { const fn = w.onResult; w.onResult = null; fn(null) } // 释放等待者（走降级）
  })
  proc.on('error', (e) => {
    w.dead = true; warmProcs.delete(chatKey)
    if (w.onResult) { const fn = w.onResult; w.onResult = null; fn(null) }
    log('热窗口spawn错误:', e.message)
  })
  return w
}

function getWarm(chatKey, tools, model, effort) {
  const key = JSON.stringify({ t: tools, m: model, e: effort || '' })
  let w = warmProcs.get(chatKey)
  if (w && (w.dead || w.key !== key || Date.now() - w.bornAt > WARM_MAX_AGE_MS)) { killWarm(chatKey); w = null }
  if (!w) {
    // 容量满时淘汰最久没用的群聊窗口（私聊窗口永不挤）；全是私聊则走冷启兜底
    if (warmProcs.size >= WARM_MAX_PROCS) {
      const groups = [...warmProcs.entries()].filter(([k]) => k.startsWith('group:')).sort((a, b) => a[1].lastAt - b[1].lastAt)
      if (groups.length) { log('热窗口容量满，回收群聊:', groups[0][0].slice(0, 16)); killWarm(groups[0][0]) }
      else throw new Error('热窗口容量已满')
    }
    w = spawnWarm(chatKey, getSession(chatKey), tools, model, effort); warmProcs.set(chatKey, w)
  }
  w.lastAt = Date.now()
  return w
}

// 长任务进度播报：从会话文件统计 sinceTs 以来的工具调用 + 最新思考片段
const TOOL_LABEL = { Bash: '跑命令', ViewImage: '查看图片', Read: '读文件', Grep: '搜内容', Glob: '找文件', Write: '写文件', Edit: '改文件', DeferExecuteTool: '生成图片' }

// 会话查看器：从会话文件提取可读条目（用户消息/思考/工具调用/图片产出/回复）
function sessTxt(e) {
  const c = e.content || (e.message && e.message.content)
  if (typeof c === 'string') return c.replace(/\s+/g, ' ').slice(0, 200)
  if (Array.isArray(c)) return c.filter(p => p && (p.type === 'text' || p.type === 'input_text') && p.text).map(p => p.text).join(' ').replace(/\s+/g, ' ').slice(0, 200)
  return ''
}
function briefArg(e) {
  let a = null
  try { a = typeof e.arguments === 'string' ? JSON.parse(e.arguments) : e.arguments } catch {}
  if (a && typeof a === 'object') {
    for (const key of ['command', 'prompt', 'file_path', 'path', 'query']) if (a[key]) return String(a[key])
    try { return JSON.stringify(a) } catch { return '' }
  }
  return String(e.arguments || '')
}
function sessionLines(sid, max = 200) {
  const lines = []
  try {
    const f = SESS_DIR + '/' + sid + '.jsonl'
    const st = fs.statSync(f)
    const len = Math.min(st.size, 500000)
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const raw = buf.toString('utf8').split('\n')
    for (let i = raw.length - 1; i >= 0 && lines.length < max; i--) {
      const l = raw[i].trim()
      if (!l || l[0] !== '{') continue
      let e; try { e = JSON.parse(l) } catch { continue }
      const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : ''
      let kind = null, x = ''
      if (e.type === 'user') { const t = sessTxt(e); if (t) { kind = 'u'; x = t } }
      else if (e.type === 'reasoning') {
        const t = (e.rawContent || []).filter(p => p && p.type === 'reasoning_text' && p.text).map(p => p.text).join(' ').replace(/\s+/g, ' ')
        if (t) { kind = 'r'; x = t.slice(0, 160) }
      } else if (e.type === 'function_call' && e.name) { kind = 't'; x = (TOOL_LABEL[e.name] || e.name) + '：' + briefArg(e).replace(/\s+/g, ' ').slice(0, 110) }
      else if (e.type === 'function_call_result' || e.type === 'toolResult') {
        const m = l.match(/generated-images\/[^\s"'\\)]+\.(?:png|jpe?g|webp)/)
        if (m) { kind = 'i'; x = '产出图片 ' + m[0].split('/').pop() }
      } else if (e.type === 'assistant') { const t = sessTxt(e); if (t) { kind = 'a'; x = t.slice(0, 400) } }
      if (kind) lines.push({ t: ts, k: kind, x })
    }
    lines.reverse()
  } catch {}
  return lines
}

function progressDigest(sid, sinceTs) {
  if (!sid) return null
  try {
    const f = SESS_DIR + '/' + sid + '.jsonl'
    const st = fs.statSync(f)
    const len = Math.min(st.size, 200000)
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const counts = {}
    let steps = 0, thought = null, lastAt = 0
    for (const line of buf.toString('utf8').split('\n')) {
      const l = line.trim()
      if (!l || l[0] !== '{') continue
      let e; try { e = JSON.parse(l) } catch { continue }
      const ts = e.timestamp
      if (!ts || ts < sinceTs) continue
      if (e.type === 'function_call' && e.name) { steps++; counts[e.name] = (counts[e.name] || 0) + 1; lastAt = ts }
      else if (e.type === 'reasoning' && Array.isArray(e.rawContent)) {
        const t = e.rawContent.filter(p => p && p.type === 'reasoning_text' && p.text).map(p => p.text).join(' ').trim()
        if (t) thought = t
      }
    }
    if (!steps) return null
    const toolStr = Object.entries(counts).map(([n, c]) => (TOOL_LABEL[n] || n) + '×' + c).join('、')
    const age = lastAt ? Math.round((Date.now() - lastAt) / 1000) : 0
    let msg = '⏳ 还在干活：这单已经跑了 ' + steps + ' 步（' + toolStr + '）'
    if (thought) msg += '\n它在想：' + thought.replace(/\s+/g, ' ').slice(0, 80)
    if (age > 120) msg += '\n（最后一步动作在 ' + Math.round(age / 60) + ' 分钟前，多半在等慢操作出结果）'
    return msg
  } catch { return null }
}

function askWarm(chatKey, prompt, tools, model, effort, prog) {
  return new Promise((resolve, reject) => {
    let w
    try { w = getWarm(chatKey, tools, model, effort) } catch (e) { return reject(e) }
    let settled = false
    const startedAt = Date.now()
    const stopAll = () => { clearTimeout(timer); if (ticker) clearInterval(ticker) }
    // 卡死保险丝
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stopAll()
      log('热窗口卡死保险丝触发(30分钟):', chatKey.slice(0, 12))
      killWarm(chatKey)
      reject(Object.assign(new Error('stalled'), { stalled: true }))
    }, WARM_STALL_MS)
    // 进度播报：60秒没出结果报第一次，之后每90秒一次，最多5次；正常快任务零打扰
    let progSent = 0
    const ticker = prog ? setInterval(async () => {
      if (settled) return
      const el = Date.now() - startedAt
      const due = 60000 + progSent * 90000
      if (el < due || progSent >= 5) return
      const digest = progressDigest(w.sid, startedAt)
      if (digest) {
        progSent++
        try { await replyText(prog.openid, digest, prog.replyOpts) } catch {}
      }
    }, 15000) : null
    const finish = (j) => {
      if (settled) return
      if (!j) { settled = true; stopAll(); return reject(new Error('热窗口进程中断')) }
      settled = true
      stopAll()
      let ans = String(j.result ?? j.content ?? '')
      if (!ans && j.is_error) ans = ''
      // DSML 工具标记残留 / 内部JSON残骸 → 从会话文件抢救真实回复
      if (ans.includes('DSML') || looksLikeJunk(ans)) {
        log('热窗口返回异常:', ans.slice(0, 70).replace(/\n/g, ' '))
        const rec = recoverFromSession(w.sid)
        if (rec) ans = rec
        else {
          const pre = ans.split(/<\uff5c+DSML/)[0].trim() // 取标记前的正文
          if (!(pre.length >= 10)) ans = ''
          else ans = pre
        }
      }
      if (!ans) ans = '（这单返回异常，再发一次试试）'
      resolve({ ans, sid: w.sid, noSession: false, imgs: imgsFrom(ans) })
    }
    w.onResult = finish
    w.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n', (err) => {
      if (err && !settled) { settled = true; clearTimeout(timer); killWarm(chatKey); reject(new Error('stdin: ' + err.message)) }
    })
  })
}

// 统一入口：主人私聊+全权 → 热窗口；其余（群聊/纯聊/只读）→ 冷启；热窗口故障自动冷启兜底
async function runAsk(chatKey, prompt, sid, tools, model, useWarm, effort, prog) {
  if (useWarm) {
    try { return await askWarm(chatKey, prompt, tools, model, effort, prog) }
    catch (e) {
      if (e && e.stalled) {
        return { ans: '⏱ 刚才那单卡住超过半小时没动静，我把窗口重置了（对话记忆还在）。这单需要的话重新发一次。', sid: null, noSession: false, imgs: [] }
      }
      log('热窗口异常，冷启兜底:', e.message)
    }
  }
  return runCLI(prompt, sid, tools, model, effort)
}

// ---------- 消息处理 ----------
// 入站去重：WS 重连时网关会重投同一条消息，按 msg_id 丢掉第二次
const seenMsgs = new Map()
function isDupMsg(id) {
  if (!id) return false
  if (seenMsgs.has(id)) return true
  seenMsgs.set(id, Date.now())
  if (seenMsgs.size > 800) {
    const now = Date.now()
    for (const [k, t] of seenMsgs) if (now - t > 3600000) seenMsgs.delete(k)
    while (seenMsgs.size > 500) seenMsgs.delete(seenMsgs.keys().next().value)
  }
  return false
}
const pendingConfirm = new Map() // chatKey -> {sid, tools, model}：生图积分确认
const lastTextMap = new Map()    // chatKey -> 最近一条回复正文（切文字模式时补发）

async function downloadAtt(att) {
  const r = await fetch(att.url, { timeout: 20000 })
  if (!r.ok) throw new Error('附件下载 HTTP ' + r.status)
  return Buffer.from(await r.arrayBuffer())
}

async function handleMessage(content, openid, opts = {}) {
  const isGroup = !!opts.groupId
  const chatKey = isGroup ? 'group:' + opts.groupId : 'c2c:' + openid
  const replyOpts = { groupId: opts.groupId, msgId: opts.msgId }
  if (!isGroup && openid !== OWNER) { log('忽略非白名单私聊:', openid); return }
  if (isDupMsg(opts.msgId)) { log('重复投递已忽略:', String(opts.msgId).slice(0, 12)); return }
  lastMsgAt = Date.now()

  // 指令（不进队列）
  if (/^(清除记忆|新话题|\/clear|\/new)$/i.test(content)) {
    clearSession(chatKey)
    killWarm(chatKey)
    log(isGroup ? '群聊开新话题' : '主人开新话题', chatKey.slice(0, 18))
    try { await replyText(openid, '已开启新话题，之前的对话不再带入 🆕', replyOpts) } catch {}
    return
  }
  if (!isGroup) {
    const modeCmd = { '纯聊模式': 'chat', '只读模式': 'ro', '全权模式': 'full' }[content]
    const vm = content.match(/^(语音模式|文字模式)(?:\s*(?:发我|一下|谢谢|哈|哦|了))?\s*[。!！~～]?$/)
    if (modeCmd || vm) {
      const cfg = loadCfg()
      if (modeCmd) cfg.mode = modeCmd
      if (vm) cfg.voice = { ...cfg.voice, reply: vm[1] === '语音模式' ? 'voice' : 'text' }
      saveCfg(cfg)
      log('QQ 配置切换 →', modeCmd ? MODE_LABEL[modeCmd] : (vm[1] === '语音模式' ? '语音回复' : '文字回复'))
      let extra = ''
      if (vm && vm[1] === '文字模式') {
        const lt = lastTextMap.get(chatKey)
        if (lt) extra = '\n\n——上一条的内容——\n' + lt.slice(0, 900)
      }
      try { await replyText(openid, (modeCmd ? `已切换到「${MODE_LABEL[modeCmd]}」模式 ✅` : `已切换为${vm[1] === '语音模式' ? '语音' : '文字'}回复 ✅`) + extra, replyOpts) } catch {}
      return
    }
  }

  state.busyWins++
  try {
    await withWin(chatKey, async () => {
      const cfg = loadCfg()
      const effMode = isGroup ? 'chat' : cfg.mode
      let prompt = content
      let hasImage = false
      let voiceIn = false

      // ---- 附件预处理：语音转文字 / 图片落盘 ----
      const atts = opts.attachments || []
      for (const att of atts) {
        try {
          const ct = String(att.content_type || att.type || '')
          const buf = await downloadAtt(att)
          if (/voice|audio/i.test(ct) || (!ct && isSilk(buf))) {
            const wav = isSilk(buf) ? await silkToWav(buf) : buf
            const text = await sfASR(wav)
            voiceIn = true
            log('语音识别:', chatKey.slice(0, 12), '→', text.slice(0, 60))
            prompt = prompt ? `${prompt}\n（用户这条还发了一段语音，内容是：${text}）` : text
          } else if (/image|img/i.test(ct) || (!ct && buf[0] === 0x89)) {
            const p = `/tmp/botimg/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`
            fs.mkdirSync('/tmp/botimg', { recursive: true })
            fs.writeFileSync(p, buf)
            hasImage = true
            prompt = `用户发来一张图片，已保存在 ${p}（用 ViewImage 工具查看）。\n用户说：${prompt || '（无文字，看图回应）'}`
          }
        } catch (e) { log('附件处理失败:', e.message) }
      }

      // 热窗口适用：私聊（全权）常开；群聊文字消息也保温（回完话留几分钟，空闲自动回收）；带图消息冷启
      const useWarm = cfg.memory && ((!isGroup && effMode === 'full') || (isGroup && !hasImage))

      // ---- 生图积分确认状态机 ----
      const pend = pendingConfirm.get(chatKey)
      if (pend) {
        pendingConfirm.delete(chatKey)
        if (/^(y|yes|1|好|嗯|行|确认|继续)$/i.test(content.trim())) {
          log('生图确认 →', chatKey.slice(0, 12))
          const r = await runAsk(chatKey, '确认，继续生成', pend.sid, pend.tools, pend.model, !isGroup && pend.tools === 'default', pend.effort, { openid, replyOpts })
          if (r.sid) setSession(chatKey, r.sid)
          await deliver(openid, chatKey, r, cfg, replyOpts, voiceIn)
          return
        }
        if (/^(n|no|0|不|取消|算了)$/i.test(content.trim())) {
          try { await replyText(openid, '已取消生图 👌', replyOpts) } catch {}
          return
        }
        // 其他输入：当作新消息继续正常处理
      }

      // ---- 会话与执行 ----
      let sid = cfg.memory ? getSession(chatKey) : null
      const tools = toolsFor(effMode, hasImage)
      const full = cfg.persona ? `【人设设定，请始终以此身份回复】\n${cfg.persona}\n\n【用户消息】\n${prompt}` : prompt
      log((isGroup ? '[群聊] ' : '') + '处理:', String(content).slice(0, 60), `(模型 ${cfg.model} · ${MODE_LABEL[effMode] || effMode} · 思考${cfg.effort || '默认'}${cfg.memory ? ',记忆' + (sid ? '续' : '新') : ',无记忆'}${hasImage ? ',带图' : ''}${useWarm ? ',热窗口' : ''})`)
      let r = await runAsk(chatKey, full, sid, tools, cfg.model, useWarm, cfg.effort, { openid, replyOpts })
      if (r.noSession) { clearSession(chatKey); killWarm(chatKey); r = await runCLI(full, null, tools, cfg.model, cfg.effort) }
      if (r.sid) setSession(chatKey, r.sid); else touchSession(chatKey)
      state.handled++
      state.lastMsg = { at: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), q: String(content).slice(0, 50), a: r.ans.slice(0, 50) }

      // ---- 生图确认拦截 ----
      if (r.ans.includes('积分') && /确认|继续/.test(r.ans) && r.ans.length < 160 && !r.imgs.length) {
        pendingConfirm.set(chatKey, { sid: r.sid, tools, model: cfg.model, effort: cfg.effort })
        try { await replyText(openid, `🖼️ ${r.ans.trim()}\n（回复 y 继续，n 取消）`, replyOpts) } catch {}
        return
      }
      await deliver(openid, chatKey, r, cfg, replyOpts, voiceIn)
    })
  } catch (e) {
    log('处理异常:', e.message)
    try { await replyText(openid, '出错了：' + e.message.slice(0, 150), replyOpts) } catch {}
  } finally { state.busyWins-- }
}

// 结果投递：图片直传 + 语音/文字回复
async function deliver(openid, chatKey, r, cfg, replyOpts, voiceIn = false) {
  const isGroup = !!replyOpts.groupId
  // 1. 生成的图片
  for (const img of r.imgs.slice(0, 4)) {
    try {
      const buf = fs.readFileSync(img)
      if (buf.length < 5 * 1024 * 1024) {
        const fi = await uploadMedia(openid, replyOpts, 1, buf, img.split('/').pop())
        await replyMedia(openid, fi, replyOpts)
        log('图片已发送:', img.split('/').pop(), `(${Math.round(buf.length / 1024)}KB)`)
      }
    } catch (e) { log('图片发送失败:', e.message) }
  }
  // 2. 文字（去掉路径残留）
  let text = r.ans.replace(RE_IMG, '').trim()
  if (!text && r.imgs.length) text = '图片已生成 ⬆️'
  lastTextMap.set(chatKey, text)
  // 3. 语音回复（私聊 + 语音模式；不限长度——唱歌也可以）
  //    mirror：跟着你的输入走，你发语音过来就回语音，你打字就回文字
  const vmode = cfg.voice?.reply === 'mirror' ? (voiceIn ? 'voice' : 'text') : (cfg.voice?.reply || 'text')
  if (!isGroup && vmode === 'voice' && text && MIMO_KEY) {
    try {
      const wav = await mimoTTS(text, cfg.voice.voice, cfg.voice.style)
      const silk = await silkFromWav(wav)
      const fi = await uploadMedia(openid, replyOpts, 3, silk, 'voice.silk')
      await replyMedia(openid, fi, replyOpts)
      log('语音回复已发送:', `${Math.round(silk.length / 1024)}KB, 音色 ${cfg.voice.voice}`)
      return
    } catch (e) { log('语音回复失败，回退文字:', e.message) }
  }
  if (text) {
    try { await replyText(openid, text, replyOpts); log('回复:', text.slice(0, 60)) } catch (e) { log('回复失败:', e.message) }
  }
}

// ---------- 主动念叨：每天 3 个随机窗口，模型自己决定发不发 ----------
const MUSE_FILE = DIR + '/proactive.json'
const MUSE_WINDOWS = [[9, 12], [14, 18], [20, 23]]
const MUSE_PROMPT = `（内部触发，不是主人发来的消息）现在轮到你自己决定要不要找主人说句话，可以不发。
你可以先看看服务器状态，或者上网翻翻 AI、技术圈的新闻，挑一件你觉得有意思、值得说的事。
值得说 → 只输出要发出去的那条消息：80 字以内，口语，像朋友随手一提；不要客套、不要问"需要我做什么"、不要分点罗列。
不值得说 → 只输出 SKIP，不要解释理由。`
function museState() { try { return JSON.parse(fs.readFileSync(MUSE_FILE, 'utf8')) } catch { return {} } }
function museSave(o) { try { fs.writeFileSync(MUSE_FILE + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(MUSE_FILE + '.tmp', MUSE_FILE) } catch {} }
let museBusy = false
async function museFire(cfg, st, idx) {
  museBusy = true
  log('主动念叨: 第', idx + 1, '个窗口触发')
  try {
    const r = await runCLI(MUSE_PROMPT, st.sid || null, 'default', cfg.model, cfg.effort)
    if (r.sid) st.sid = r.sid
    let ans = String(r.ans || '').trim()
    if (!ans || /^SKIP\b/i.test(ans) || /^[⚠⏱]/.test(ans)) { log('主动念叨: 这轮没话说'); return }
    ans = ans.replace(/^["“]|["”]$/g, '').replace(/\*\*/g, '').replace(/`/g, '').trim()
    if (ans.length < 6) { log('主动念叨: 内容太短，弃了'); return }
    const j = await replyText(OWNER, ans.slice(0, 600), {})
    if (j && j.id) {
      st.sent = (st.sent || []).slice(-19)
      st.sent.push({ t: Date.now(), text: ans.slice(0, 600) })
    }
    log('主动念叨已发送:', (j && j.id ? 'ok' : JSON.stringify(j).slice(0, 80)))
  } catch (e) { log('主动念叨失败:', e.message) } finally { museBusy = false; museSave(st) }
}
function museTick() {
  if (shuttingDown || museBusy) return
  const cfg = loadCfg()
  if (cfg.proactive === false) return
  if (state.busyWins > 0) return                      // 正在处理消息，别插队
  if (Date.now() - lastMsgAt < 20 * 60 * 1000) return // 刚聊过，不打扰
  if (memAvailMB() < 450) return                      // 内存不够，跳过这轮
  const bj = new Date(Date.now() + 8 * 3600e3)
  const dk = bj.toISOString().slice(0, 10)
  const h = bj.getUTCHours()
  const mi = bj.getUTCMinutes()
  let st = museState()
  if (st.date !== dk) st = { date: dk, fired: {}, next: {} }
  let changed = false
  for (let i = 0; i < MUSE_WINDOWS.length; i++) {
    const [a, b] = MUSE_WINDOWS[i]
    if (h < a || h >= b || st.fired[i]) continue
    if (st.next[i] == null) {
      const nowMin = h * 60 + mi
      let t = a * 60 + Math.floor(Math.random() * (b - a) * 60)
      if (t <= nowMin) t = Math.min(b * 60 - 1, nowMin + 20 + Math.floor(Math.random() * 30)) // 服务中途重启：别刚起来就念叨
      st.next[i] = t; changed = true
    }
    if (h * 60 + mi >= st.next[i]) { st.fired[i] = Date.now(); museSave(st); museFire(cfg, st, i); return }
  }
  if (changed) museSave(st)
}

// ---------- WebSocket ----------
let hb = null
let wsTries = 0          // 连续重连次数，用来做指数退避
let downAt = 0           // 掉线时刻（0 = 从未掉过线，冷启动不提醒）
let lastMsgAt = 0        // 最近一次收到用户消息的时刻
let lastNoticeAt = 0     // 上次掉线提醒的时刻，防刷
async function connectWS() {
  try {
    const t = await getToken(true)
    const gw = await (await fetch(API + '/gateway', { headers: { Authorization: `QQBot ${t}` } })).json()
    log('gateway:', gw.url)
    const ws = new WebSocket(gw.url)
    let seq = null
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.op === 10) {
        hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval)
        ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${t}`, intents: 1 << 25, shard: [0, 1] } }))
      } else if (m.op === 0) {
        seq = m.s
        if (m.t === 'READY') {
          state.online = true; state.onlineSince = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); log('QQ 机器人上线:', m.d.user?.username || APPID)
          wsTries = 0
          // 掉线期间的消息网关不会补发：只在「刚聊过」的情况下提醒一次
          if (downAt) {
            const secs = Math.round((Date.now() - downAt) / 1000)
            const recent = Date.now() - lastMsgAt < 10 * 60 * 1000
            const quiet = Date.now() - lastNoticeAt > 10 * 60 * 1000
            downAt = 0
            if (recent && quiet && secs >= 5) {
              lastNoticeAt = Date.now()
              replyText(OWNER, `⚠️ 刚掉线了 ${secs} 秒，这期间你发的消息 QQ 不会补发。要是有没回你的，再发一遍就行。`, {}).catch(() => {})
            }
          }
        }
        else if (m.t === 'C2C_MESSAGE_CREATE') handleMessage((m.d.content || '').trim(), m.d.author?.user_openid, { msgId: m.d.msg_id, attachments: m.d.attachments }).catch((e) => log('消息处理异常:', e.message))
        else if (m.t === 'GROUP_AT_MESSAGE_CREATE') {
          const d = m.d
          const text = String(d.content || '').replace(/<@![^>]*>/g, '').replace(/^@\S+\s*/, '').trim()
          handleMessage(text, d.author?.member_openid, { groupId: d.group_openid, msgId: d.msg_id, attachments: d.attachments }).catch((e) => log('群消息处理异常:', e.message))
        }
      } else if (m.op === 7) { try { ws.close() } catch {} }
    }
    ws.onclose = () => {
      state.online = false
      if (!downAt) downAt = Date.now()
      const delay = Math.min(1000 * 2 ** wsTries, 10000)
      wsTries++
      log(`WS 断开，${delay / 1000} 秒后重连`)
      if (hb) { clearInterval(hb); hb = null }
      setTimeout(connectWS, delay)
    }
    ws.onerror = () => log('WS 错误')
  } catch (e) {
    log('连接失败:', e.message, '→ 30 秒后重试')
    setTimeout(connectWS, 30000)
  }
}

// ---------- Web 控制台（仅 127.0.0.1，经 nginx /bot/ 反代） ----------
function authOk(urlObj, req) {
  const t = req.headers['x-token'] || ''
  const a = Buffer.from(String(t))
  const b = Buffer.from(PANEL_TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>deepseek 机器人控制台</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0f1420;color:#e6e9f0;margin:0;padding:16px;max-width:720px;margin-inline:auto}
h1{font-size:20px} h2{font-size:15px;color:#8fa3c8;margin:18px 0 8px}
.card{background:#1a2233;border:1px solid #2a3650;border-radius:10px;padding:14px;margin-bottom:14px}
select,textarea,input{width:100%;box-sizing:border-box;background:#101828;color:#e6e9f0;border:1px solid #2a3650;border-radius:8px;padding:9px;font-size:14px;margin:4px 0}
select option{background:#101828;color:#e6e9f0}
textarea{min-height:90px;resize:vertical}
button{background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer;margin:4px 6px 0 0}
button.warn{background:#c0392b} button.ghost{background:#2a3650}
.kv{display:flex;justify-content:space-between;padding:4px 0;font-size:14px;border-bottom:1px dashed #22304a}
.kv b{font-weight:600;color:#fff}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#e74c3c}
.dot.on{background:#2ecc71}
pre{background:#0b111e;border:1px solid #22304a;border-radius:8px;padding:10px;font-size:12px;overflow-x:auto;max-height:260px;overflow-y:auto;white-space:pre-wrap;color:#9fb0cc}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#2f6fed;padding:8px 18px;border-radius:20px;font-size:13px;display:none}
label{font-size:13px;color:#8fa3c8}
#login{max-width:360px;margin:80px auto}
#sessLog{background:#0b111e;border:1px solid #22304a;border-radius:8px;padding:10px;font-size:12px;max-height:420px;overflow-y:auto}
#sessLog .sl{margin:3px 0;white-space:pre-wrap;word-break:break-all;line-height:1.5}
#sessLog .tm{color:#5a6b8c} #sessLog .u{color:#5b9bff} #sessLog .r{color:#7d8db3;font-style:italic} #sessLog .t{color:#e6a23c} #sessLog .i{color:#2ecc71} #sessLog .a{color:#e6e9f0}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:5px 4px;border-bottom:1px dashed #22304a}
</style></head><body>
<div id="login" class="card"><h2>访问令牌</h2><input id="tk" placeholder="粘贴控制台令牌"><button onclick="saveTk()">进入</button></div>
<div id="app" style="display:none">
<h1><span class="dot" id="dot"></span>deepseek 机器人控制台</h1>
<div class="card"><h2>运行状态</h2><div id="status">加载中…</div></div>
<div class="card"><h2>模型</h2>
<select id="model"></select>
<input id="customModel" placeholder="或手动输入模型 ID">
<h2>思考强度（推理深度，越高想得越深、耗时越长；保存后下一条消息即生效）</h2>
<select id="effort">
<option value="">CLI 默认</option>
<option value="minimal">minimal — 极简</option>
<option value="low">low — 低</option>
<option value="medium">medium — 中</option>
<option value="high">high — 高</option>
<option value="xhigh">xhigh — 超高</option>
<option value="max">max — 最高</option>
</select>
</div>
<div class="card"><h2>人设（每次对话自动附带，可留空）</h2>
<textarea id="persona" placeholder="例：你是一个毒舌但热心的朋友，回复简短口语化"></textarea>
</div>
<div class="card"><h2>对话记忆与模式</h2>
<label><input type="checkbox" id="memory" style="width:auto"> 跨消息记忆（每个聊天窗口独立、永久保留；QQ 里发「新话题」可重开）</label>
<h2>模式（仅你的私聊生效，群聊永远纯聊天）</h2>
<select id="mode">
<option value="chat">纯聊天 —— 动不了服务器</option>
<option value="ro">只读管家 —— 只能查（读文件/看日志/看图），改不了东西</option>
<option value="full">全权管家 —— 可执行任意命令（root，无确认）</option>
</select>
</div>
<div class="card"><h2>语音（私聊回复）</h2>
<select id="voiceReply">
<option value="mirror">跟随输入（你发语音就回语音）</option>
<option value="text">文字回复</option>
<option value="voice">语音回复（MiMo TTS）</option>
</select>
<h2>音色</h2>
<select id="voiceName"></select>
<input id="voiceStyle" placeholder="朗读风格指令，例：用活泼欢快的语气">
</div>
<div class="card"><h2>会话窗口</h2><div id="sessions">加载中…</div>
<br><button class="warn" onclick="clearMem()">清除全部记忆</button>
<button class="ghost" onclick="restartSvc()">重启服务</button>
</div>
<div class="card" id="viewerCard" style="display:none"><h2 id="viewerTitle">会话查看</h2>
<button class="ghost" style="margin:0 0 8px" onclick="closeViewer()">收起</button>
<div id="sessLog"></div>
<p style="font-size:12px;color:#8fa3c8;margin:8px 0 0">每 5 秒自动刷新 · 🧑 你发的 · 💭 它在想 · 🔧 在调工具 · 📷 产出图片 · 🤖 它的回复</p>
</div>
<div class="card"><button onclick="save()">保存设置</button></div>
<div class="card"><h2>最近日志</h2><pre id="logs"></pre></div>
</div>
<div id="toast"></div>
<script>
var HK=(location.hash.match(/[#&]t=([^&]+)/)||[])[1]||'';if(HK){localStorage.setItem('bot_token',decodeURIComponent(HK));history.replaceState(null,'',location.pathname)}
var TOKEN=localStorage.getItem('bot_token')||'';
function saveTk(){TOKEN=document.getElementById('tk').value.trim();localStorage.setItem('bot_token',TOKEN);load()}
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(function(){t.style.display='none'},1800)}
function api(p,opt){opt=opt||{};opt.headers=Object.assign({'X-Token':TOKEN},opt.headers||{});if(opt.body){opt.headers['Content-Type']='application/json'}return fetch(p,opt)}
var MODELS=${JSON.stringify(MODELS)};var VOICES=${JSON.stringify(TTS_VOICES)};var lastModel='';
function fillModels(){var s=document.getElementById('model');s.innerHTML='';MODELS.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;s.appendChild(o)});var v=document.getElementById('voiceName');v.innerHTML='';VOICES.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;v.appendChild(o)})}
function applyModelSel(){var s=document.getElementById('model');var cm=document.getElementById('customModel');cm.value='';if(MODELS.indexOf(lastModel)>=0){s.value=lastModel}else{s.value='';if(lastModel)cm.value=lastModel}}
function applySt(d){
  document.getElementById('app').style.display='block';document.getElementById('login').style.display='none';
  document.getElementById('dot').className='dot'+(d.online?' on':'');
  var mins=Math.floor(d.uptimeMin);
  var warmTxt='未启用';
  if(d.warm&&d.warm.length){warmTxt=d.warm.map(function(x){return '常驻 '+x.ageMin+' 分钟 · '+x.rss+'MB'+(x.stalled?'':'')}).join('；')}
  else if(d.mode==='full'&&d.memory){warmTxt='待下条消息拉起'}
  document.getElementById('status').innerHTML=
    '<div class="kv"><span>QQ 连接</span><b>'+(d.online?'在线':'离线')+'</b></div>'+
    '<div class="kv"><span>当前模型</span><b>'+d.model+'</b></div>'+
    '<div class="kv"><span>思考强度</span><b>'+({minimal:'极简',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高'}[d.effort]||'CLI 默认')+'</b></div>'+
    '<div class="kv"><span>模式</span><b>'+({chat:'纯聊天',ro:'只读管家',full:'全权管家'}[d.mode]||d.mode)+'</b></div>'+
    '<div class="kv"><span>私聊热窗口</span><b>'+warmTxt+'</b></div>'+
    '<div class="kv"><span>语音</span><b>'+(d.voice&&d.voice.reply==='voice'?(d.voice.voice+'（语音回复）'):'文字回复')+'</b></div>'+
    '<div class="kv"><span>活跃会话窗口</span><b>'+((d.sessions||[]).length)+' 个</b></div>'+
    '<div class="kv"><span>已处理消息</span><b>'+d.handled+'</b></div>'+
    '<div class="kv"><span>处理中窗口</span><b>'+d.busyWins+'</b></div>'+
    '<div class="kv"><span>进程运行</span><b>'+mins+' 分钟</b></div>';
  document.getElementById('persona').value=d.persona||'';
  document.getElementById('memory').checked=!!d.memory;
  var ms=document.getElementById('mode');if(['chat','ro','full'].indexOf(d.mode)>=0)ms.value=d.mode;
  lastModel=d.model;applyModelSel();
  var ef=document.getElementById('effort');ef.value=['','minimal','low','medium','high','xhigh','max'].indexOf(d.effort)>=0?d.effort:'';
  if(d.voice){document.getElementById('voiceReply').value=d.voice.reply||'mirror';if(VOICES.indexOf(d.voice.voice)>=0)document.getElementById('voiceName').value=d.voice.voice;document.getElementById('voiceStyle').value=d.voice.style||''}
  var sv=document.getElementById('sessions');
  if((d.sessions||[]).length){sv.innerHTML='<table><tr><td>窗口</td><td>最近活跃</td><td>操作</td></tr>'+d.sessions.map(function(s){return '<tr><td>'+s.label+'</td><td>'+s.lastAt+'</td><td>'+(s.hasSid?'<button class="ghost" style="margin:0;padding:4px 10px" onclick="viewSess(&#39;'+s.k+'&#39;)">查看</button>':'无会话')+'</td></tr>'}).join('')+'</table>'}
  else sv.textContent='暂无会话（等第一条消息进来）';
  if(viewKey&&d.sessions&&d.sessions.some(function(s){return s.k===viewKey&&!s.hasSid}))closeViewer();
  document.getElementById('logs').textContent=(d.logs||[]).join('\\n');
}
function load(){api('api/status').then(function(r){if(r.status===401){document.getElementById('app').style.display='none';document.getElementById('login').style.display='block';return}return r.json()}).then(function(d){if(d)applySt(d)}).catch(function(){})}
function chosenModel(){var s=document.getElementById('model').value;var c=document.getElementById('customModel').value.trim();return c||s}
function save(){api('api/config',{method:'POST',body:JSON.stringify({model:chosenModel(),effort:document.getElementById('effort').value,persona:document.getElementById('persona').value,memory:document.getElementById('memory').checked,mode:document.getElementById('mode').value,voice:{reply:document.getElementById('voiceReply').value,voice:document.getElementById('voiceName').value,style:document.getElementById('voiceStyle').value}})}).then(function(r){if(r.status===401)return toast('令牌无效');toast('已保存 ✅ 下一条消息即生效');load()})}
function clearMem(){if(!confirm('清除全部窗口的记忆？'))return;api('api/clear-memory',{method:'POST'}).then(function(){toast('记忆已清除 ✅');load()})}
var viewKey=null,viewTimer=null,viewLabel='';
function viewSess(k){viewKey=k;viewLabel=k.indexOf('group:')===0?'群聊':'私聊（你）';document.getElementById('viewerCard').style.display='block';document.getElementById('viewerTitle').textContent='会话查看 — '+viewLabel;loadSess()}
function closeViewer(){viewKey=null;document.getElementById('viewerCard').style.display='none';if(viewTimer){clearTimeout(viewTimer);viewTimer=null}}
function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function loadSess(){if(!viewKey)return;api('api/session?k='+encodeURIComponent(viewKey)).then(function(r){return r.json()}).then(function(d){renderSess(d);viewTimer=setTimeout(loadSess,5000)}).catch(function(){viewTimer=setTimeout(loadSess,8000)})}
function renderSess(d){var el=document.getElementById('sessLog');var ic={u:'🧑',r:'💭',t:'🔧',i:'📷',a:'🤖'};var h='';
  if(d.note)h+='<div class="sl r">'+escH(d.note)+'</div>';
  (d.lines||[]).forEach(function(l){h+='<div class="sl"><span class="tm">'+l.t+'</span> '+ic[l.k]+' <span class="'+l.k+'">'+escH(l.x)+'</span></div>'});
  var follow=el.scrollHeight-el.scrollTop-el.clientHeight<30;var keep=el.scrollTop;
  el.innerHTML=h;
  el.scrollTop=follow?el.scrollHeight:keep}
function restartSvc(){if(!confirm('重启桥接服务？QQ 机器人会断线几秒'))return;api('api/restart',{method:'POST'}).then(function(){toast('重启中…页面稍后自动刷新');setTimeout(function(){location.reload()},5000)})}
fillModels();load();setInterval(load,5000);
api('api/models').then(function(r){return r.json()}).then(function(d){if(d.models&&d.models.length&&d.models.join()!==MODELS.join()){MODELS=d.models;fillModels();applyModelSel()}}).catch(function(){});
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const deny = () => { res.writeHead(401); res.end('unauthorized') }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(PAGE)
  }
  if (u.pathname === '/api/models') {
    if (!authOk(u, req)) return deny()
    return res.end(JSON.stringify({ models: cliModels() }))
  }
  if (u.pathname === '/api/session') {
    if (!authOk(u, req)) return deny()
    const k = u.searchParams.get('k') || ''
    const sess = loadSessions()
    const sid = sess[k] && sess[k].sid
    if (!sid || !/^[0-9a-f-]{8,64}$/.test(sid)) return res.end(JSON.stringify({ lines: [], note: '该窗口暂无会话记录' }))
    const lines = sessionLines(sid)
    return res.end(JSON.stringify({ sid: sid.slice(0, 8), lines, note: lines.length ? '' : '会话文件还是空的' }))
  }
  if (u.pathname === '/api/status') {
    if (!authOk(u, req)) return deny()
    const cfg = loadCfg()
    const sess = loadSessions()
    const sessions = Object.entries(sess).map(([k, v]) => ({
      k,
      label: k.startsWith('group:') ? '群聊 ' + k.slice(6, 14) : '私聊（你）',
      lastAt: v.at ? new Date(v.at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '-',
      hasSid: !!v.sid,
    }))
    const warm = [...warmProcs.values()].map(w => ({
      key: w.chatKey.slice(0, 14), ageMin: Math.floor((Date.now() - w.bornAt) / 60000), rss: rssOf(w.proc.pid), sid: w.sid ? w.sid.slice(0, 8) : null,
    }))
    return res.end(JSON.stringify({
      online: state.online, model: cfg.model, effort: cfg.effort || '', persona: cfg.persona, memory: !!cfg.memory, mode: cfg.mode, voice: cfg.voice,
      sessions, warm, handled: state.handled, busyWins: state.busyWins,
      uptimeMin: Math.floor((Date.now() - state.startedAt) / 60000),
      lastMsg: state.lastMsg, logs: logsBuf.slice(-60),
      voiceReady: !!MIMO_KEY && !!SF_KEY,
    }))
  }
  if (u.pathname === '/api/config' && req.method === 'POST') {
    if (!authOk(u, req)) return deny()
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 100000) req.destroy() })
    req.on('end', () => {
      try {
        const c = JSON.parse(body || '{}')
        const next = loadCfg()
        if (c.model !== undefined) {
          if (!/^[a-zA-Z0-9._-]{1,60}$/.test(c.model)) { res.writeHead(400); return res.end('bad model') }
          next.model = c.model
        }
        if (c.effort !== undefined) {
          if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.effort)) { res.writeHead(400); return res.end('bad effort') }
          next.effort = c.effort
        }
        if (c.persona !== undefined) next.persona = String(c.persona).slice(0, 2000)
        if (c.memory !== undefined) next.memory = !!c.memory
        if (c.mode !== undefined) {
          if (!['chat', 'ro', 'full'].includes(c.mode)) { res.writeHead(400); return res.end('bad mode') }
          next.mode = c.mode
        }
        if (c.voice && typeof c.voice === 'object') {
          if (c.voice.reply !== undefined) next.voice.reply = c.voice.reply === 'voice' ? 'voice' : 'text'
          if (c.voice.voice !== undefined && TTS_VOICES.includes(c.voice.voice)) next.voice.voice = c.voice.voice
          if (c.voice.style !== undefined) next.voice.style = String(c.voice.style).slice(0, 300)
        }
        saveCfg(next)
        log('控制台更新配置: 模型', next.model, '思考', next.effort || '默认', '模式', MODE_LABEL[next.mode], '语音', next.voice.reply === 'voice' ? next.voice.voice : '关')
        res.writeHead(200); res.end('ok')
      } catch { res.writeHead(400); res.end('bad json') }
    })
    return
  }
  if (u.pathname === '/api/clear-memory' && req.method === 'POST') {
    if (!authOk(u, req)) return deny()
    clearAllSessions()
    killAllWarm()
    log('控制台清除全部记忆')
    res.writeHead(200); return res.end('ok')
  }
  if (u.pathname === '/api/restart' && req.method === 'POST') {
    if (!authOk(u, req)) return deny()
    log('控制台请求重启服务')
    res.writeHead(200); res.end('restarting')
    setTimeout(() => {
      const p = spawn('systemctl', ['restart', 'workbuddy-bridge'], { detached: true, stdio: 'ignore' })
      p.unref()
    }, 300)
    return
  }
  res.writeHead(404); res.end('not found')
})
server.listen(PANEL_PORT, '127.0.0.1', () => log('控制台端口 127.0.0.1:' + PANEL_PORT))

// 群聊热窗口空闲回收：回完话保温几分钟，没人接着说话就自动关（私聊常开，不回收）
setInterval(() => {
  for (const [k, w] of [...warmProcs.entries()]) {
    if (k.startsWith('group:') && Date.now() - w.lastAt > GROUP_WARM_IDLE_MS) {
      log('群聊热窗口空闲回收:', k.slice(0, 16))
      killWarm(k)
    }
  }
}, 60000)

// 主动念叨：每分钟检查一次是否到了今天的随机时间点
setInterval(museTick, 60000)

// ---------- 退出清理 + 主人窗口预热 ----------
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  killAllWarm()
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

if (!MIMO_KEY) log('⚠️ 未配置 MIMO_API_KEY，语音回复不可用（voice.env）')
if (!SF_KEY) log('⚠️ 未配置 SF_API_KEY，语音识别不可用（voice.env）')
connectWS()

// 启动 8 秒后预热主人私聊热窗口（全权+记忆开启时），第一条消息也免冷启
setTimeout(() => {
  try {
    const cfg = loadCfg()
    if (cfg.memory && cfg.mode === 'full') getWarm('c2c:' + OWNER, 'default', cfg.model, cfg.effort)
  } catch (e) { log('预热未拉起:', e.message) }
}, 8000)
