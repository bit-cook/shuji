#!/usr/bin/env bash
# 枢机安装脚本：把控制面、命令路由与 Sidecar 装成系统服务（最小权限账号）。
# 用法： sudo ./install.sh [--dest DIR] [--dry-run] [--uninstall] [--yes]
#   默认目标：mission-control=/opt/mission-control
#            wechat-bridge=/opt/wechat-bridge
#            hermes-sidecar=/opt/hermes-sidecar
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

# 落盘 + 建最小权限账号的组件
COMPONENTS=(mission-control wechat-bridge hermes-sidecar)
# systemd 单元比组件多一个：Telegram 入口与 HTTP 入口共用 wechat-bridge 账号、
# 同一份代码与日志目录，只有环境文件（令牌 / 白名单 / 审计文件名）不同——
# 一个进程只跑一个适配器，所以必须是两个单元，但不必多一个账号。
SERVICES=(mission-control wechat-bridge wechat-bridge-telegram hermes-sidecar)

run() { if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] $*"; else "$@"; fi }
confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  read -r -p "$1 [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# ---------------- 卸载 ----------------
if [[ $UNINSTALL -eq 1 ]]; then
  echo "== 枢机卸载（目标：$DEST）=="
  confirm "停止并禁用 ${SERVICES[*]} 服务？" || { echo "已取消"; exit 0; }
  run systemctl disable --now "${SERVICES[@]}" || true
  for unit in "${SERVICES[@]}"; do
    run rm -f "/etc/systemd/system/$unit.service"
  done
  run systemctl daemon-reload
  confirm "删除落盘文件 ${COMPONENTS[*]}？" || { echo "保留文件，仅卸载服务"; exit 0; }
  for c in "${COMPONENTS[@]}"; do run rm -rf "$DEST/$c"; done
  run rm -f /etc/logrotate.d/wechat-bridge /etc/logrotate.d/mission-control
  echo "已完成。系统账号 ${COMPONENTS[*]} 未删除（如需：userdel）。"
  echo "环境文件 /etc/{$(IFS=,; echo "${SERVICES[*]}")}.env 未删除（含密钥，请自行处置）。"
  exit 0
fi

echo "== 枢机安装（源：$REPO_ROOT → 目标：$DEST）=="

# 0. 运行前提：控制面用 node:sqlite，Node 24 才无需实验 flag
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "[错误] 需要 Node 22.5+（控制面依赖 node:sqlite），当前主版本号 $NODE_MAJOR" >&2
  exit 1
fi

# 1. 最小权限专用账号（红线：禁止 root 常驻）
for c in "${COMPONENTS[@]}"; do
  if ! id "$c" &>/dev/null; then
    run useradd --system --home /nonexistent --shell /usr/sbin/nologin "$c"
  fi
done

# 2. 落盘组件
run mkdir -p "$DEST/mission-control" "$DEST/wechat-bridge" "$DEST/hermes-sidecar" \
  /var/log/wechat-bridge /var/log/mission-control /var/lib/mission-control
run cp -r "$REPO_ROOT/packages/mission-control/src" "$REPO_ROOT/packages/mission-control/package.json" "$DEST/mission-control/"
run cp -r "$REPO_ROOT/packages/wechat-bridge/src" "$REPO_ROOT/packages/wechat-bridge/package.json" "$DEST/wechat-bridge/"
run cp "$REPO_ROOT/packages/hermes-sidecar/sidecar.py" "$DEST/hermes-sidecar/"
run chmod 644 "$DEST/hermes-sidecar/sidecar.py"

# 3. systemd 单元（路径按 DEST 重写）。Telegram 入口共用 wechat-bridge 账号，
#    但它自己的单元里 User=wechat-bridge 已写死，这里只换路径前缀。
for unit in "${SERVICES[@]}"; do
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] 生成 /etc/systemd/system/$unit.service（路径前缀 $DEST）"
  else
    sed "s|/opt/|$DEST/|g" "$REPO_ROOT/deploy/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
    echo "已写入 /etc/systemd/system/$unit.service"
  fi
done

# 4. 日志轮转（各组件自带大小轮转，这里按天再兜一层）
if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] 安装 /etc/logrotate.d/wechat-bridge 与 /etc/logrotate.d/mission-control"
else
  cp "$REPO_ROOT/deploy/logrotate/wechat-bridge" /etc/logrotate.d/wechat-bridge
  cp "$REPO_ROOT/deploy/logrotate/mission-control" /etc/logrotate.d/mission-control
fi

for c in "${COMPONENTS[@]}"; do
  run chown -R "$c:$c" "$DEST/$c"
done
run chown -R wechat-bridge:wechat-bridge /var/log/wechat-bridge
run chown -R mission-control:mission-control /var/log/mission-control /var/lib/mission-control
# 控制面数据目录只允许属主进入（内含 Agent 明细与任务标题）
run chmod 750 /var/lib/mission-control

# 5. 启动前自检：环境文件在位、权限正确、白名单不是模板占位值
echo
echo "== 启动前自检 =="
FAIL=0
for name in "${SERVICES[@]}"; do
  envfile="/etc/$name.env"
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
  if [[ "$name" == "mission-control" ]] && grep -qE '^MC_API_KEY= *(替换为|TODO|$)' "$envfile"; then
    echo "  [错误] $envfile 的 MC_API_KEY 还是占位值——控制面无鉴权等于全局可下令（红线）"
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
echo "  1. 如自检有缺失：cp $REPO_ROOT/deploy/env/<组件>.env.example /etc/<组件>.env && chmod 600 /etc/<组件>.env"
echo "  2. systemctl enable --now mission-control            # 先起控制面"
echo "  3. systemctl enable --now wechat-bridge wechat-bridge-telegram hermes-sidecar"
echo "  4. journalctl -u mission-control -u wechat-bridge -u wechat-bridge-telegram -u hermes-sidecar -f"
echo "  5. 校验监听未暴露公网：ss -tlnp | grep -E '3000|8080'"
