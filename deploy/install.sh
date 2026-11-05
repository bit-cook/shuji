#!/usr/bin/env bash
# 枢机安装脚本：把命令路由与 Sidecar 装成系统服务（最小权限账号）。
# 用法： sudo ./install.sh [--dest DIR] [--dry-run] [--uninstall] [--yes]
#   默认目标：bridge=/opt/wechat-bridge  sidecar=/opt/hermes-sidecar
#   环境文件需自行从 deploy/env/*.example 复制到 /etc/*.env 并 chmod 600
#   --uninstall：停服务、删单元与落盘文件（不删系统账号，需 --yes 确认）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEST:-/opt}"
DRY_RUN=0
UNINSTALL=0
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

run() { if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] $*"; else "$@"; fi; }
confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  read -r -p "$1 [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# ---------------- 卸载 ----------------
if [[ $UNINSTALL -eq 1 ]]; then
  echo "== 枢机卸载（目标：$DEST）=="
  confirm "停止并禁用 wechat-bridge / hermes-sidecar 服务？" || { echo "已取消"; exit 0; }
  run systemctl disable --now wechat-bridge hermes-sidecar || true
  run rm -f /etc/systemd/system/wechat-bridge.service /etc/systemd/system/hermes-sidecar.service
  run systemctl daemon-reload
  confirm "删除落盘文件 $DEST/wechat-bridge 与 $DEST/hermes-sidecar？" || { echo "保留文件，仅卸载服务"; exit 0; }
  run rm -rf "$DEST/wechat-bridge" "$DEST/hermes-sidecar"
  run rm -f /etc/logrotate.d/wechat-bridge
  echo "已完成。系统账号 wechat-bridge / hermes-sidecar 未删除（如需：userdel）。"
  echo "环境文件 /etc/wechat-bridge.env、/etc/hermes-sidecar.env 未删除（含密钥，请自行处置）。"
  exit 0
fi

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

# 4. 日志轮转（bridge 自带大小轮转，这里按天再兜一层）
if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] 安装 /etc/logrotate.d/wechat-bridge"
else
  cp "$REPO_ROOT/deploy/logrotate/wechat-bridge" /etc/logrotate.d/wechat-bridge
fi

run chown -R wechat-bridge:wechat-bridge "$DEST/wechat-bridge" /var/log/wechat-bridge
run chown -R hermes-sidecar:hermes-sidecar "$DEST/hermes-sidecar"

# 5. 启动前自检：环境文件在位、权限正确、白名单不是模板占位值
echo
echo "== 启动前自检 =="
FAIL=0
for pair in "wechat-bridge:/etc/wechat-bridge.env" "hermes-sidecar:/etc/hermes-sidecar.env"; do
  name="${pair%%:*}"; envfile="${pair##*:}"
  if [[ ! -f "$envfile" ]]; then
    echo "  [缺失] $envfile —— 请从 $REPO_ROOT/deploy/env/$name.env.example 复制"
    FAIL=1
    continue
  fi
  perm="$(stat -c '%a' "$envfile" 2>/dev/null || echo '?')"
  if [[ "$perm" != "600" ]]; then
    echo "  [警告] $envfile 权限为 $perm，建议 chmod 600（含密钥）"
  else
    echo "  [OK] $envfile 权限 600"
  fi
  if grep -qE '^(WECHAT_ALLOW_FROM|TELEGRAM_ALLOW_FROM)= *(你的|替换为|TODO|$)' "$envfile"; then
    echo "  [错误] $envfile 的白名单还是模板占位值——不填好就不启动（红线：只接受本人）"
    FAIL=1
  fi
done
if [[ $FAIL -eq 1 ]]; then
  echo "自检未通过：请先补齐环境文件，再执行 systemctl enable --now。"
else
  echo "自检通过。"
fi

run systemctl daemon-reload
echo
echo "接下来："
echo "  1. 如自检有缺失：cp $REPO_ROOT/deploy/env/wechat-bridge.env.example /etc/wechat-bridge.env && chmod 600 /etc/wechat-bridge.env"
echo "  2. systemctl enable --now wechat-bridge hermes-sidecar"
echo "  3. journalctl -u wechat-bridge -u hermes-sidecar -f"
echo "  4. 校验监听未暴露公网：ss -tlnp | grep -E '8080|3000'"
