#!/usr/bin/env bash
# 枢机安装脚本：把命令路由与 Sidecar 装成系统服务（最小权限账号）。
# 用法： sudo ./install.sh [--dest DIR] [--dry-run]
#   默认目标：bridge=/opt/wechat-bridge  sidecar=/opt/hermes-sidecar
#   环境文件需自行从 deploy/env/*.example 复制到 /etc/*.env 并 chmod 600
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEST:-/opt}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

run() { if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] $*"; else "$@"; fi; }

echo "== 枢机安装（源：$REPO_ROOT → 目标：$DEST）=="

# 1. 最小权限专用账号（红线：禁止 root 常驻）
if ! id wechat-bridge &>/dev/null; then
  run useradd --system --home /nonexistent --shell /usr/sbin/nologin wechat-bridge
fi
if ! id hermes-sidecar &>/dev/null; then
  run useradd --system --home /nonexistent --shell /usr/sbin/nologin hermes-sidecar
fi

# 2. 落盘组件
run mkdir -p "$DEST/wechat-bridge" "$DEST/hermes-sidecar" /var/log/wechat-bridge
run cp -r "$REPO_ROOT/packages/wechat-bridge/src" "$REPO_ROOT/packages/wechat-bridge/package.json" "$DEST/wechat-bridge/"
run cp "$REPO_ROOT/packages/hermes-sidecar/sidecar.py" "$DEST/hermes-sidecar/"
run chmod 644 "$DEST/hermes-sidecar/sidecar.py"

# 3. systemd 单元（路径按 DEST 重写）
for unit in wechat-bridge hermes-sidecar; do
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] 生成 /etc/systemd/system/$unit.service（路径前缀 $DEST）"
  else
    sed "s|/opt/|$DEST/|g" "$REPO_ROOT/deploy/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
    echo "已写入 /etc/systemd/system/$unit.service"
  fi
done
run chown -R wechat-bridge:wechat-bridge "$DEST/wechat-bridge" /var/log/wechat-bridge
run chown -R hermes-sidecar:hermes-sidecar "$DEST/hermes-sidecar"

# 4. 启动
run systemctl daemon-reload
echo
echo "接下来："
echo "  1. 复制环境模板并填入真实值（chmod 600）："
echo "     cp $REPO_ROOT/deploy/env/wechat-bridge.env.example /etc/wechat-bridge.env"
echo "     cp $REPO_ROOT/deploy/env/hermes-sidecar.env.example /etc/hermes-sidecar.env"
echo "  2. systemctl enable --now wechat-bridge hermes-sidecar"
echo "  3. journalctl -u wechat-bridge -u hermes-sidecar -f"
