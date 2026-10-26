// QQ 官方机器人：openid 抓取 + 私聊推送（api.bot.qq.com）
// 用法: node qqbot.mjs capture   —— 监听私聊事件，抓取 user_openid 后退出
//       node qqbot.mjs [文本]   —— 推送文本到已保存的 openid
import fs from 'fs'
import os from 'os'
import path from 'path'

const DIR = process.env.WB_DIR || path.dirname(new URL(import.meta.url).pathname)
const APPID = process.env.QQBOT_APPID
const SECRET = process.env.QQBOT_APP_SECRET
const OPENID_FILE = process.env.QQ_OPENID_FILE || DIR + '/owner-openid.txt'
const API = 'https://api.bot.qq.com'

if (!APPID || !SECRET) {
  console.log('missing QQBOT_APPID / QQBOT_APP_SECRET env')
  process.exit(1)
}

async function getToken() {
  const r = await fetch(API + '/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APPID, clientSecret: SECRET }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error('token failed: ' + JSON.stringify(j).slice(0, 200))
  return j.access_token
}

export async function pushQQ(text) {
  const openid = fs.readFileSync(OPENID_FILE, 'utf8').trim()
  if (!openid) throw new Error('openid not captured yet')
  const token = await getToken()
  const r = await fetch(`${API}/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 0, content: text }),
    signal: AbortSignal.timeout(30000),
  })
  return r.json()
}

async function capture() {
  const token = await getToken()
  const gwRes = await fetch(API + '/gateway', {
    headers: { Authorization: `QQBot ${token}` },
  })
  const gw = await gwRes.json()
  console.log('gateway:', gw.url || JSON.stringify(gw))
  const ws = new WebSocket(gw.url)
  let lastSeq = null
  let hb = null
  const done = (openid, content) => {
    fs.writeFileSync(OPENID_FILE, openid)
    console.log('CAPTURED openid:', openid)
    console.log('message content:', (content || '').slice(0, 80))
    try { if (hb) clearInterval(hb) } catch {}
    try { ws.close() } catch {}
    setTimeout(() => process.exit(0), 300)
  }
  ws.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.op === 10) {
      console.log('HELLO, heartbeat', m.d.heartbeat_interval, 'ms; identifying...')
      hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: lastSeq })), m.d.heartbeat_interval)
      ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } }))
    } else if (m.op === 0) {
      lastSeq = m.s
      if (m.t === 'READY') {
        console.log('READY as', m.d.user?.username || 'bot')
      } else if (m.t === 'C2C_MESSAGE_CREATE') {
        done(m.d.author?.user_openid, m.d.content)
      } else {
        console.log('event:', m.t)
      }
    } else if (m.op === 7) {
      console.log('server asked reconnect; exiting for retry')
      process.exit(2)
    }
  }
  ws.onclose = () => { if (hb) clearInterval(hb) }
  ws.onerror = () => console.log('ws error')
  setTimeout(() => { console.log('TIMEOUT: no private message in 150s'); process.exit(1) }, 150000)
}

import { pathToFileURL } from 'url'
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
const mode = process.argv[2] || 'push'
if (mode === 'capture') {
  await capture()
} else {
  const text = process.argv.slice(3).join(' ') || 'QQ推送通道测试 ✅'
  try {
    const j = await pushQQ(text)
    console.log('push resp:', JSON.stringify(j).slice(0, 200))
  } catch (e) {
    console.log('push fail:', e.message.slice(0, 200))
    process.exit(1)
  }
}
}
