#!/usr/bin/env python3
"""枢机 · Hermes 心跳 Sidecar —— 仅用 Python 标准库。

周期性采集 Hermes 状态，按 Mission-Control generic 协议上报心跳：
  POST {MC_BASE}/api/agents/heartbeat
  {"framework":"generic","action":"heartbeat",
   "payload":{"agentId":..., "status":"online|offline", "reportedAt":..., "detail":{...}}}

状态来源（按序）：
  1. Hermes RPC（HERMES_RPC，默认 http://127.0.0.1:8765/status）
  2. 退化：systemctl is-active <SYSTEMD_UNIT>（自动识别 system / --user 作用域）
  3. 两者皆不可用 → offline

特性：
  - 失败指数退避（带抖动）；401/403 快速失败并以退出码 4 结束——密钥错误重试无益，
    配合 systemd StartLimit 让单元进入 failed 状态被看见，而不是无声刷日志
  - SIGTERM 优雅退出（分片 sleep，信号即时响应）
  - JSON 结构化日志（journald 友好）
  - --once 单次模式（供测试/验收）、--dry-run 只打印报文不发送、--interval 覆盖周期

退出码：0 正常 / 1 心跳失败（--once）/ 2 配置错误 / 4 鉴权失败（密钥问题）
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import random
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

__version__ = "0.3.0"

log = logging.getLogger("hermes-sidecar")

DEFAULTS = {
    "AGENT_ID": "hermes-node-b",
    "HERMES_RPC": "http://127.0.0.1:8765/status",
    "INTERVAL": "300",
    "SYSTEMD_UNIT": "agent-gateway",
    "SYSTEMD_SCOPE": "auto",
    "RETRY_MAX": "3",
    "RETRY_BACKOFF": "2",
    "REQUEST_TIMEOUT": "10",
}

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG = 2
EXIT_AUTH = 4

# systemctl is-active 的退出码：0=active，3=没有这个单元，其余=已知但未运行
SYSTEMCTL_NO_SUCH_UNIT = 3
SCOPES = ("auto", "system", "user")


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.mc_base = env.get("MC_BASE", "").rstrip("/")
        self.mc_api_key = env.get("MC_API_KEY", "")
        self.agent_id = env.get("AGENT_ID", DEFAULTS["AGENT_ID"])
        self.hermes_rpc = env.get("HERMES_RPC", DEFAULTS["HERMES_RPC"])
        self.interval = int(env.get("INTERVAL", DEFAULTS["INTERVAL"]))
        self.systemd_unit = env.get("SYSTEMD_UNIT", DEFAULTS["SYSTEMD_UNIT"])
        scope = str(env.get("SYSTEMD_SCOPE", DEFAULTS["SYSTEMD_SCOPE"])).strip().lower() or "auto"
        if scope not in SCOPES:
            raise ValueError(f"SYSTEMD_SCOPE 只能是 {'/'.join(SCOPES)}，当前为 {scope}")
        self.systemd_scope = scope
        self.retry_max = int(env.get("RETRY_MAX", DEFAULTS["RETRY_MAX"]))
        self.retry_backoff = float(env.get("RETRY_BACKOFF", DEFAULTS["RETRY_BACKOFF"]))
        self.request_timeout = float(env.get("REQUEST_TIMEOUT", DEFAULTS["REQUEST_TIMEOUT"]))
        if not self.mc_base:
            raise ValueError("MC_BASE 未配置（管理面地址，红线：仅内网可达）")
        if not self.mc_api_key:
            raise ValueError("MC_API_KEY 未配置（管理面 API Key）")
        if self.interval < 1:
            raise ValueError("INTERVAL 至少 1 秒")

    def as_dict(self):
        return {
            "mc_base": self.mc_base,
            "agent_id": self.agent_id,
            "hermes_rpc": self.hermes_rpc,
            "interval": self.interval,
            "systemd_unit": self.systemd_unit,
            "systemd_scope": self.systemd_scope,
        }


def _systemctl(unit, scope, timeout):
    """跑一次 systemctl is-active。返回 (returncode, stdout)。"""
    cmd = ["systemctl"]
    if scope == "user":
        cmd.append("--user")
    cmd += ["is-active", unit]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return out.returncode, (out.stdout or "").strip()


def probe_systemd(cfg, run=None) -> tuple[str, dict]:
    """查 systemd 单元状态，自动识别 system / --user 作用域。

    实测踩过的坑：Hermes 网关是 **用户级** 单元（~/.config/systemd/user/）。
    在 root 下不带 --user 查 `systemctl is-active hermes-gateway.service`
    会得到退出码 3（没有这个单元），sidecar 于是把活着的 Hermes 报成 offline。
    """
    run = run or _systemctl
    unit = cfg.systemd_unit
    if not unit:
        return "offline", {"source": "none", "error": "SYSTEMD_UNIT 未配置"}
    scopes = [cfg.systemd_scope] if cfg.systemd_scope != "auto" else ["system", "user"]
    for scope in scopes:
        try:
            code, state = run(unit, scope, cfg.request_timeout)
        except Exception as e:  # noqa: BLE001 - systemctl 不存在/超时都算查不到
            log.debug("systemctl(%s) 查询失败：%s", scope, e)
            continue
        detail = {"source": "systemd", "unit": unit, "scope": scope, "state": state or "unknown"}
        if code == 0:
            return "online", detail
        # 只有 auto 模式、且 system 作用域明确说「没有这个单元」时，才继续试 user 作用域
        retry_user = (
            cfg.systemd_scope == "auto" and scope == "system" and code == SYSTEMCTL_NO_SUCH_UNIT
        )
        if not retry_user:
            return "offline", detail
    return "offline", {"source": "none", "unit": unit, "error": "systemd 不可用"}


def fetch_status(cfg: Config, urlopen=urllib.request.urlopen, run=None) -> tuple[str, dict]:
    """返回 (status, detail)。RPC 优先，systemd 兜底。"""
    try:
        with urlopen(cfg.hermes_rpc, timeout=cfg.request_timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return "online", {"source": "hermes-rpc", "detail": data}
    except Exception as e:  # noqa: BLE001 - 任何 RPC 失败都退化
        log.debug("hermes rpc 不可用：%s", e)
    return probe_systemd(cfg, run=run)


def build_payload(cfg: Config, status: str, detail: dict) -> dict:
    """generic 协议心跳报文。detail 里带上回报方信息，面板可溯源。"""
    return {
        "framework": "generic",
        "action": "heartbeat",
        "payload": {
            "agentId": cfg.agent_id,
            "status": status,
            "reportedAt": int(time.time()),
            "detail": {
                **detail,
                "reportedBy": f"hermes-sidecar/{__version__}",
                "pid": os.getpid(),
            },
        },
    }


def post_heartbeat(
    cfg: Config, status: str, detail: dict, urlopen=urllib.request.urlopen, dry_run: bool = False
) -> dict:
    body = json.dumps(build_payload(cfg, status, detail)).encode("utf-8")
    if dry_run:
        log.info(json.dumps({"event": "dry-run", "payload": build_payload(cfg, status, detail)},
                            ensure_ascii=False))
        return {"ok": True, "dryRun": True}
    req = urllib.request.Request(
        cfg.mc_base + "/api/agents/heartbeat",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg.mc_api_key,
            "User-Agent": f"hermes-sidecar/{__version__} ({platform.system()})",
        },
        method="POST",
    )
    with urlopen(req, timeout=cfg.request_timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_once(
    cfg: Config,
    urlopen=urllib.request.urlopen,
    sleep=time.sleep,
    dry_run: bool = False,
    report=None,
) -> bool:
    """单次心跳；带指数退避（含抖动）重试。成功返回 True。

    report(dict) 可选回调，上报每次尝试的结果；main() 据此区分
    「鉴权失败（该退出）」与「瞬时失败（该继续）」。
    """
    status, detail = fetch_status(cfg, urlopen=urlopen)
    attempt = 0
    while True:
        attempt += 1
        try:
            r = post_heartbeat(cfg, status, detail, urlopen=urlopen, dry_run=dry_run)
            log.info(json.dumps({
                "event": "heartbeat", "agentId": cfg.agent_id, "status": status,
                "attempt": attempt, "ok": True, "response": r,
            }, ensure_ascii=False))
            if report:
                report({"ok": True, "attempt": attempt, "status": status})
            return True
        except urllib.error.HTTPError as e:
            with e:  # 读干并关闭响应体，避免 ResourceWarning
                body = e.read().decode("utf-8", "replace")[:200]
            log.warning(json.dumps({
                "event": "heartbeat", "agentId": cfg.agent_id, "status": status,
                "attempt": attempt, "ok": False, "http": e.code, "body": body,
            }, ensure_ascii=False))
            if report:
                report({"ok": False, "attempt": attempt, "status": status, "http": e.code})
            # 401/403 是配置问题，重试无益，快速失败
            if e.code in (401, 403):
                return False
        except Exception as e:  # noqa: BLE001
            log.warning(json.dumps({
                "event": "heartbeat", "agentId": cfg.agent_id, "status": status,
                "attempt": attempt, "ok": False, "error": str(e),
            }, ensure_ascii=False))
            if report:
                report({"ok": False, "attempt": attempt, "status": status, "error": str(e)})
        if attempt >= cfg.retry_max:
            return False
        # 指数退避 + ±25% 抖动，避免多节点同时重试打管理面
        base = cfg.retry_backoff * attempt
        sleep(base * (0.75 + random.random() * 0.5))


_stop = False


def _handle_term(signum, frame):  # noqa: ANN001
    global _stop
    _stop = True
    log.info(json.dumps({"event": "signal", "signal": signum, "action": "shutdown"}, ensure_ascii=False))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Hermes -> Mission-Control 心跳 Sidecar")
    parser.add_argument("--once", action="store_true", help="只跑一次心跳后退出（测试/验收用）")
    parser.add_argument("--dry-run", action="store_true", help="只打印心跳报文，不发送（调试用）")
    parser.add_argument("--interval", type=int, default=None, help="覆盖心跳周期（秒）")
    parser.add_argument("--verbose", action="store_true", help="DEBUG 日志")
    parser.add_argument("--version", action="store_true", help="打印版本")
    args = parser.parse_args(argv)

    if args.version:
        print(__version__)
        return 0

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        stream=sys.stdout,
        format="%(message)s",
    )
    try:
        cfg = Config()
    except ValueError as e:
        log.error(json.dumps({"event": "config_error", "error": str(e)}, ensure_ascii=False))
        return EXIT_CONFIG

    if args.interval is not None:
        if args.interval < 1:
            log.error(json.dumps({"event": "config_error", "error": "--interval 至少 1 秒"}, ensure_ascii=False))
            return EXIT_CONFIG
        cfg.interval = args.interval

    log.info(json.dumps({
        "event": "start", "version": __version__, **cfg.as_dict(),
    }, ensure_ascii=False))

    if args.once:
        return EXIT_OK if run_once(cfg, dry_run=args.dry_run) else EXIT_FAILED

    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    auth_failed = {"v": False}

    def rep(ev):  # noqa: ANN001
        if not ev.get("ok") and ev.get("http") in (401, 403):
            auth_failed["v"] = True

    while not _stop:
        run_once(cfg, dry_run=args.dry_run, report=rep)
        if auth_failed["v"]:
            # 密钥错误：重试无益。以非零码退出，让 systemd StartLimit 把单元
            # 置为 failed（可见），而不是无声地每周期刷 401 日志。
            log.error(json.dumps({
                "event": "auth_failed", "agentId": cfg.agent_id,
                "error": "管理面返回 401/403：检查 MC_API_KEY 与白名单配置",
            }, ensure_ascii=False))
            return EXIT_AUTH
        # 可被信号打断的分片 sleep
        slept = 0.0
        while not _stop and slept < cfg.interval:
            time.sleep(min(1.0, cfg.interval - slept))
            slept += 1.0
    log.info(json.dumps({"event": "stop"}, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
