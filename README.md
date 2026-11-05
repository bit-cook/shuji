# 枢机 · Cardinal

> **Everything hinges on it.** 万事，系于此枢。

枢机是 **Agenos** 项目的控制面实现：把散落在各主机上的 Agent 收进一个控制点——微信下令，全局回报。
项目计划与文档（交接文档 / 部署手册 / 对话全记录）在另一个仓库：[bit-cook/cardinal-plan](https://github.com/bit-cook/cardinal-plan)（站点：https://osome.work/cardinal-plan/）。

## 本仓库包含什么

| 目录 | 内容 |
| --- | --- |
| `packages/wechat-bridge/` | 命令路由（Node，零第三方依赖）：allowFrom 白名单、六条命令协议、危险命令二次确认、企业微信回调加解密、JSONL 审计日志 |
| `packages/hermes-sidecar/` | Hermes 心跳 Sidecar（Python 仅标准库）：generic 协议心跳、RPC→systemd 状态退化、重试退避、SIGTERM 优雅退出 |
| `deploy/` | docker-compose、Dockerfile、systemd 加固单元、环境变量模板、安装脚本 |
| `test/` | Mission-Control 测试桩 + T1–T8 端到端验收脚本（`node test/e2e.js`） |

## 安全红线（实现即约束）

- 命令入口白名单 `WECHAT_ALLOW_FROM`：只接受本人，其余一律拒绝（含审计留痕）
- 危险命令（`/dispatch` 等）60 秒内 `/confirm <token>` 二次确认后才执行，令牌一次性、仅发起人可用
- 密钥只走环境变量 / EnvironmentFile，`chmod 600`，不入库、不入镜像
- 服务以最小权限专用账号运行，`NoNewPrivileges` + `ProtectSystem=strict`，禁止 root 常驻
- 端口默认只绑 `127.0.0.1`；跨主机场景只绑 Tailscale 网卡

## 命令协议（微信直接发文本）

| 命令 | 含义 | 管理面动作 |
| --- | --- | --- |
| `/ping` | 链路自检 | 固定返回 pong + 时间戳 |
| `/list` | 全部 Agent 状态 | `GET /api/agents` |
| `/status <id>` | 单个 Agent 详情 | `GET /api/agents/<id>` |
| `/tasks <id>` | 最近任务 | `GET /api/agents/<id>/tasks` |
| `/cost` | Token 成本汇总 | `GET /api/costs/summary` |
| `/dispatch <id> <任务>` | 下发任务（需二次确认） | `POST /api/tasks` |

## 快速开始（本地 3 分钟跑通验收）

```bash
# 1. 单测：bridge 25 项 + sidecar 14 项
npm run test:bridge
npm run test:sidecar

# 2. 端到端验收 T1–T8（mock 控制面 + mock Hermes + 真 sidecar 子进程 + 真 bridge）
npm run test:e2e

# 3. 手动起一套玩
node test/mock-mission-control.js 3000 &          # 假控制面
MC_BASE=http://127.0.0.1:3000 MC_API_KEY=test-key \
  WECHAT_ALLOW_FROM=me ADAPTER=http PORT=8080 \
  node packages/wechat-bridge/src/cli.js &        # 命令路由（HTTP 适配器）
curl -s -XPOST localhost:8080/message -H 'Content-Type: application/json' \
  -d '{"from":"me","text":"/ping"}'               # → {"reply":"pong · ..."}
```

## 部署

见 `deploy/`：`docker compose -f deploy/docker-compose.yml up -d`（控制面 + 路由），
Hermes 主机上用 `sudo deploy/install.sh` 装 Sidecar，或按 `deploy/env/*.example` 配置 systemd 单元。
完整 11 阶段手册：[部署手册](https://osome.work/cardinal-plan/docs/runbook.html)。

## 测试现状（每次提交由 CI 复跑）

- `wechat-bridge`：25 项 node:test（含企业微信回调加解密真服务器往返、白名单、二次确认、审计、截断）
- `hermes-sidecar`：14 项 unittest（心跳报文/鉴权头、401 快速失败、500 重试、systemd 退化、CLI 退出码）
- `e2e`：T1–T8 全过（链路/安全/状态/告警/恢复/计量/调度/韧性）

## 许可

MIT
