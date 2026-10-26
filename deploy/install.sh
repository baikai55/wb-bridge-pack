#!/usr/bin/env bash
# 一键部署到 /opt/wb-bridge（只会补充缺失的文件，不会覆盖已有配置）
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${WB_INSTALL_DIR:-/opt/wb-bridge}"

command -v node >/dev/null || { echo "先装 Node 20+"; exit 1; }
node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node 版本需要 >= 20"; exit 1; }

mkdir -p "$DST"
cp -n "$SRC/bridge.mjs" "$SRC/qqbot.mjs" "$SRC/package.json" "$DST/" 2>/dev/null || true
[ -f "$DST/bridge.env" ] || cp "$SRC/bridge.env.example" "$DST/bridge.env"
[ -f "$DST/voice.env" ]  || cp "$SRC/voice.env.example" "$DST/voice.env"
chmod 600 "$DST/bridge.env" "$DST/voice.env"

cd "$DST"
npm install --omit=dev --no-audit --no-fund

if [ ! -f "$DST/owner-openid.txt" ]; then
  echo
  echo "还差一步：抓取主人 openid"
  echo "  1) 在 $DST/bridge.env 里填好 QQBOT_APPID / QQBOT_APP_SECRET"
  echo "  2) 运行：node $DST/qqbot.mjs capture"
  echo "  3) 用 QQ 给机器人发一条消息，程序会自动把 openid 写进 owner-openid.txt"
fi

if [ -f "$SRC/deploy/workbuddy-bridge.service" ] && [ -d /etc/systemd/system ]; then
  sed "s#/opt/wb-bridge#$DST#g" "$SRC/deploy/workbuddy-bridge.service" > /etc/systemd/system/workbuddy-bridge.service
  systemctl daemon-reload
  systemctl enable --now workbuddy-bridge
  echo "服务已启动：systemctl status workbuddy-bridge"
fi

echo
echo "控制台令牌：$DST/panel-token.txt（首次启动自动生成；浏览器访问 http://127.0.0.1:8791/#t=令牌，令牌只存在地址栏 # 后，不会进日志）"
