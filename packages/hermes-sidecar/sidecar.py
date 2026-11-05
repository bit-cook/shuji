#!/usr/bin/env python3
"""枢机 · Hermes 心跳 Sidecar —— 仅用 Python 标准库。

周期性采集 Hermes 状态，按 Mission-Control generic 协议上报心跳：
  POST {MC_BASE}/api/agents/heartbeat
  {"framework":"generic","action":"heartbeat",
   "payload":{"agentId":..., "status":"online|offline", "reportedAt":..., "detail":{...}}}

状态来源（按序）：
  1. Hermes RPC（HERMES_RPC，默认 http://127.0.0.1:8765/status）
  2. 退化：systemctl is-active <SYSTEMD_UNIT>
  3. 两者皆不可用 → offline

特性：失败重试退避、SIGTERM 优雅退出、JSON 结构化日志（journald 友好）、--once 单次模式（供测试/验收）。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

log = logging.getLogger("hermes-sidecar")

DEFAULTS = {
    "AGENT_ID": "hermes-node-b",
    "HERMES_RPC": "http://127.0.0.1:8765/status",
    "INTERVAL": "300",
    "SYSTEMD_UNIT": "agent-gateway",
    "RETRY_MAX": "3",
    "RETRY_BACKOFF": "2",
    "REQUEST_TIMEOUT": "10",
}


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.mc_base = env.get("MC_BASE", "").rstrip("/")
        self.mc_api_key = env.get("MC_API_KEY", "")
        self.agent_id = env.get("AGENT_ID", DEFAULTS["AGENT_ID"])
        self.hermes_rpc = env.get("HERMES_RPC", DEFAULTS["HERMES_RPC"])
        self.interval = int(env.get("INTERVAL", DEFAULTS["INTERVAL"]))
        self.systemd_unit = env.get("SYSTEMD_UNIT", DEFAULTS["SYSTEMD_UNIT"])
        self.retry_max = int(env.get("RETRY_MAX", DEFAULTS["RETRY_MAX"]))
        self.retry_backoff = float(env.get("RETRY_BACKOFF", DEFAULTS["RETRY_BACKOFF"]))
        self.request_timeout = float(env.get("REQUEST_TIMEOUT", DEFAULTS["REQUEST_TIMEOUT"]))
        if not self.mc_base:
            raise ValueError("MC_BASE 未配置（管理面地址，红线：仅内网可达）")
        if not self.mc_api_key:
            raise ValueError("MC_API_KEY 未配置（管理面 API Key）")

    def as_dict(self):
        return {
            "mc_base": self.mc_base,
            "agent_id": self.agent_id,
            "hermes_rpc": self.hermes_rpc,
            "interval": self.interval,
            "systemd_unit": self.systemd_unit,
        }


def fetch_status(cfg: Config, urlopen=urllib.request.urlopen) -> tuple[str, dict]:
    """返回 (status, detail)。RPC 优先，systemd 兜底。"""
    try:
        with urlopen(cfg.hermes_rpc, timeout=cfg.request_timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return "online", {"source": "hermes-rpc", "detail": data}
    except Exception as e:  # noqa: BLE001 - 任何 RPC 失败都退化
        log.debug("hermes rpc 不可用：%s", e)
    try:
        out = subprocess.run(
            ["systemctl", "is-active", cfg.systemd_unit],
            capture_output=True, text=True, timeout=cfg.request_timeout,
        )
        state = out.stdout.strip()
        if state == "active":
            return "online", {"source": "systemd", "unit": cfg.systemd_unit}
        return "offline", {"source": "systemd", "unit": cfg.systemd_unit, "state": state}
    except Exception as e:  # noqa: BLE001
        log.debug("systemd 查询失败：%s", e)
        return "offline", {"source": "none", "error": str(e)}


def post_heartbeat(cfg: Config, status: str, detail: dict, urlopen=urllib.request.urlopen) -> dict:
    body = json.dumps({
        "framework": "generic",
        "action": "heartbeat",
        "payload": {
            "agentId": cfg.agent_id,
            "status": status,
            "reportedAt": int(time.time()),
            "detail": detail,
        },
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg.mc_base + "/api/agents/heartbeat",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg.mc_api_key,
        },
        method="POST",
    )
    with urlopen(req, timeout=cfg.request_timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_once(cfg: Config, urlopen=urllib.request.urlopen, sleep=time.sleep) -> bool:
    """单次心跳；带指数退避重试。成功返回 True。"""
    status, detail = fetch_status(cfg, urlopen=urlopen)
    attempt = 0
    while True:
        attempt += 1
        try:
            r = post_heartbeat(cfg, status, detail, urlopen=urlopen)
            log.info(json.dumps({
                "event": "heartbeat", "agentId": cfg.agent_id, "status": status,
                "attempt": attempt, "ok": True, "response": r,
            }, ensure_ascii=False))
            return True
        except urllib.error.HTTPError as e:
            with e:  # 读干并关闭响应体，避免 ResourceWarning
                body = e.read().decode("utf-8", "replace")[:200]
            log.warning(json.dumps({
                "event": "heartbeat", "agentId": cfg.agent_id, "status": status,
                "attempt": attempt, "ok": False, "http": e.code, "body": body,
            }, ensure_ascii=False))
            # 401/403 是配置问题，重试无益，快速失败
            if e.code in (401, 403):
                return False
        except Exception as e:  # noqa: BLE001
            log.warning(json.dumps({
                "event": "heartbeat", "agentId": cfg.agent_id, "status": status,
                "attempt": attempt, "ok": False, "error": str(e),
            }, ensure_ascii=False))
        if attempt >= cfg.retry_max:
            return False
        sleep(cfg.retry_backoff * attempt)


_stop = False


def _handle_term(signum, frame):  # noqa: ANN001
    global _stop
    _stop = True
    log.info(json.dumps({"event": "signal", "signal": signum, "action": "shutdown"}, ensure_ascii=False))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Hermes -> Mission-Control 心跳 Sidecar")
    parser.add_argument("--once", action="store_true", help="只跑一次心跳后退出（测试/验收用）")
    parser.add_argument("--verbose", action="store_true", help="DEBUG 日志")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        stream=sys.stdout,
        format="%(message)s",
    )
    try:
        cfg = Config()
    except ValueError as e:
        log.error(json.dumps({"event": "config_error", "error": str(e)}, ensure_ascii=False))
        return 2

    log.info(json.dumps({"event": "start", **cfg.as_dict()}, ensure_ascii=False))

    if args.once:
        return 0 if run_once(cfg) else 1

    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)
    while not _stop:
        run_once(cfg)
        # 可被信号打断的分片 sleep
        slept = 0.0
        while not _stop and slept < cfg.interval:
            time.sleep(min(1.0, cfg.interval - slept))
            slept += 1.0
    log.info(json.dumps({"event": "stop"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
