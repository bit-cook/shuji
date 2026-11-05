#!/usr/bin/env bash
# 等第一个人给枢机 Telegram 机器人发消息，然后把整条 Telegram 链路接完：
#   1. 从环境文件读机器人令牌（唯一来源，换机器人只改一处）
#   2. getUpdates 长轮询等第一个非机器人发送者
#   3. 把它的数字用户 ID 写进 TELEGRAM_ALLOW_FROM（红线：只留本人）
#   4. 装并启动 cardinal-wechat-bridge-telegram 用户服务
#   5. 回一条消息告诉对方可以再发一次 /ping
#
# 用法：bash deploy/wait-telegram-sender.sh [超时秒数，默认 1800]
# 说明：getUpdates 与桥的长轮询互斥，所以发现阶段桥不能同时跑；
#       本脚本一发现就退出并把桥拉起来，之后的消息由桥自己接。
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENVFILE="$REPO/deploy/env/wechat-bridge-telegram.env"
UNIT_DIR="${HOME}/.config/systemd/user"
STATUS=/tmp/tg-sender.json
TIMEOUT="${1:-1800}"

[ -f "$ENVFILE" ] || { echo "[fail] 找不到 $ENVFILE" >&2; exit 2; }

TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENVFILE" | head -1)"
[ -n "$TOKEN" ] || { echo "[fail] $ENVFILE 里没有 TELEGRAM_BOT_TOKEN" >&2; exit 2; }
API="https://api.telegram.org/bot${TOKEN}"

rm -f "$STATUS"
deadline=$(( $(date +%s) + TIMEOUT ))
echo "[wait] 等待有人给枢机机器人发消息（最长 ${TIMEOUT}s）…" >&2

while [ "$(date +%s)" -lt "$deadline" ]; do
  resp="$(curl -s --max-time 35 "${API}/getUpdates?timeout=30&limit=5" || true)"
  [ -z "$resp" ] && continue

  hit="$(printf '%s' "$resp" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not d.get("ok"):
    sys.exit(0)
for u in d.get("result", []):
    m = u.get("message") or u.get("edited_message") or {}
    frm = m.get("from") or {}
    if frm.get("is_bot"):
        continue
    chat = m.get("chat") or {}
    print(json.dumps({
        "update_id": u.get("update_id"),
        "user_id": frm.get("id"),
        "username": frm.get("username"),
        "first_name": frm.get("first_name"),
        "chat_id": chat.get("id"),
        "chat_type": chat.get("type"),
        "text": m.get("text"),
    }, ensure_ascii=False))
    break
')"

  if [ -n "$hit" ]; then
    printf '%s\n' "$hit" > "$STATUS"
    echo "[wait] 抓到发送者：$hit" >&2

    uid="$(printf '%s' "$hit" | python3 -c 'import sys,json;print(json.load(sys.stdin)["user_id"])')"
    chat="$(printf '%s' "$hit" | python3 -c 'import sys,json;print(json.load(sys.stdin)["chat_id"])')"

    # 写白名单（红线：只留本人）
    python3 - "$ENVFILE" "$uid" <<'PY'
import re, sys
p, uid = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s2 = re.sub(r'^TELEGRAM_ALLOW_FROM=.*$', 'TELEGRAM_ALLOW_FROM=' + uid, s, flags=re.M)
assert s2 != s, 'TELEGRAM_ALLOW_FROM 未替换'
# 认人之后就不该再吃积压消息
s2 = re.sub(r'^TELEGRAM_DRAIN_BACKLOG=.*$', 'TELEGRAM_DRAIN_BACKLOG=1', s2, flags=re.M)
open(p, 'w', encoding='utf-8').write(s2)
print('[wait] 白名单已写入 user_id=' + uid)
PY

    # 装 + 起服务
    cp "$REPO/deploy/systemd-user/wechat-bridge-telegram.service" \
       "$UNIT_DIR/cardinal-wechat-bridge-telegram.service"
    systemctl --user daemon-reload
    systemctl --user enable --now cardinal-wechat-bridge-telegram >/dev/null 2>&1
    sleep 2
    state="$(systemctl --user is-active cardinal-wechat-bridge-telegram || true)"
    echo "[wait] cardinal-wechat-bridge-telegram -> $state" >&2

    # 回一条，让对方知道可以再发一次
    curl -s --max-time 10 -X POST "${API}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "{\"chat_id\":${chat},\"text\":\"枢机已认出你（user_id=${uid}），白名单与 Telegram 入口都已配好。\\n再发一次 /ping 试试。\"}" >/dev/null

    printf '{"user_id":%s,"service":"%s"}\n' "$uid" "$state" > "${STATUS}.done"
    exit 0
  fi
done

echo "[wait] 超时未收到消息" >&2
exit 1
