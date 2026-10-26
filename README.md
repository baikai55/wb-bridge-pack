# WorkBuddy QQ Bridge

把 **CodeBuddy CLI** 接成 QQ 官方机器人：私聊里就是一个能查服务器、改代码、发图发语音的 AI 管家。

单文件 Node 程序，无数据库，常驻内存约 400MB（含 CLI 子进程）。

## 特性

- **私聊全权管家**：一条消息一个 CodeBuddy 会话，权限可切「纯聊天 / 只读 / 全权」
- **热窗口**：私聊常驻一个 CLI 进程，靠 `stream-json` 喂消息，不用每条重开；死了自动 `-r` 续接
- **语音全双工**：发语音 → ASR 转文字；回语音（跟随输入 / 强制语音 / 强制文字三档）
- **图片双向**：收图自动落盘识别，出图直接上传发送
- **Web 控制台**：改模型、人设、模式、音色，看会话，清记忆，重启服务
- **输出兜底**：输出流截断时从会话文件抢救最后一条回复，不把 JSON 残骸发给用户
- **入站去重**：按 `msg_id` 丢弃网关重投的消息

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 20 | `fetch`、`FormData`、全局 `WebSocket` 都要 |
| CodeBuddy CLI | 已登录，路径改 `WB_CLI` |
| QQ 机器人 | 在 [QQ 开放平台](https://q.qq.com) 建机器人，拿 AppID / AppSecret |
| 一台能跑的机器 | 2G 内存起步；同时跑别的服务建议 4G |

语音另需：MiMo（TTS）和硅基流动（ASR）的 Key，纯文字可以不配。

## 快速开始

```bash
git clone <this repo> wb-bridge && cd wb-bridge
npm install
node qqbot.mjs capture        # 先抓 openid
```

`capture` 运行后，用 QQ 给机器人发任意一条消息，终端会打印 `CAPTURED openid` 并写入 `owner-openid.txt`。

然后配置并启动：

```bash
cp bridge.env.example bridge.env && chmod 600 bridge.env
vi bridge.env                 # 填 QQBOT_APPID / QQBOT_APP_SECRET
node bridge.mjs
```

想用 systemd 托管：

```bash
sudo bash deploy/install.sh   # 装到 /opt/wb-bridge 并注册服务
```

## 配置

### bridge.env（必需）

| 变量 | 说明 |
| --- | --- |
| `QQBOT_APPID` / `QQBOT_APP_SECRET` | QQ 机器人凭据 |
| `WB_DIR` | 程序目录，默认取 `bridge.mjs` 所在目录 |
| `WB_CLI` | CodeBuddy CLI 路径，默认 `/opt/node22/bin/codebuddy` |
| `WB_HOME` / `WB_CWD` | CLI 的 HOME 与工作目录；会话文件在 `$WB_HOME/.codebuddy/projects/<cwd名>/` |
| `WB_SESS_DIR` | 直接指定会话目录（覆盖上一条的推导） |
| `QQ_OPENID_FILE` | 默认 `<WB_DIR>/owner-openid.txt` |
| `BOT_PANEL_PORT` | 控制台端口，默认 8791，只监听 127.0.0.1 |

### voice.env（可选）

`MIMO_API_KEY`、`SF_API_KEY`，可选 `TTS_MODEL` / `ASR_MODEL`。文件不存在就自动关闭语音功能。

### 运行期配置

`bot-config.json` 由控制台写入，也可以手改：

```json
{
  "model": "deepseek-v4.1-flash",
  "persona": "",
  "memory": true,
  "mode": "full",
  "effort": "max",
  "voice": { "reply": "mirror", "voice": "冰糖", "style": "" },
  "proactive": false
}
```

- `mode`：`chat` 纯聊天 / `ro` 只读 / `full` 全权
- `voice.reply`：`mirror` 跟随输入 / `voice` 总是语音 / `text` 总是文字
- `proactive`：是否开启「主动念叨」定时推送（三个随机时间窗，模型自己决定发不发）

## Web 控制台

只监听 `127.0.0.1:8791`，鉴权用请求头 `X-Token`。令牌首次启动时生成在 `panel-token.txt`。

浏览器打开 `http://127.0.0.1:8791/#t=<令牌>`：令牌放在 `#` 后面，浏览器不会发给服务器，也不会进访问日志。想远程访问就用 nginx 反代到 8791。

## 安全说明

这个项目默认是「本机主人专用」，开箱的默认值并不适合直接暴露：

- 私聊只服务白名单里的 `owner-openid.txt`，其他人一律忽略
- 全权模式下 CLI 以 `bypassPermissions` 运行，**能执行任意命令**。别用 root 跑，建个专用用户；真被拿到 QQ 号，等于交出 shell
- 控制台别直接暴露公网，前面套一层带 TLS 的反代
- `bridge.env` / `voice.env` / `panel-token.txt` / `owner-openid.txt` 都要 `chmod 600`，`.gitignore` 已排掉

## 常见问题

**Q：一条消息要等很久？**
A：全权模式下一条消息起一个 CLI 会话，思考强度越高越慢。私聊热窗口会复用进程，只有冷启（重启后第一条、群聊）才明显慢。

**Q：语音不回？**
A：先看日志有没有 `未配置 MIMO_API_KEY`；再确认 `bot-config.json` 里 `voice.reply` 不是 `text`。

**Q：图片发不出去？**
A：单条回复最多发 4 张，超过的会截断。

**Q：换机器要注意什么？**
A：同一个 AppID 不能两台同时在线，会互踢。要在另一台跑，就在开放平台再建一个机器人。

## License

MIT
