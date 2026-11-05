# 枢机 · Cardinal

> **Everything hinges on it.** 万事，系于此枢。

枢机是 **Agenos** 项目的控制面实现：把散落在各主机上的 Agent 收进一个控制点——下令，全局回报。
项目计划与文档（交接文档 / 部署手册 / 对话全记录）在另一个仓库：[bit-cook/cardinal-plan](https://github.com/bit-cook/cardinal-plan)（站点：https://osome.work/cardinal-plan/）。

## 入口：微信（主线）+ Telegram

| 入口 | 路径 | 适配器 |
| --- | --- | --- |
| 微信（个人号，官方 ClawBot/iLink） | 微信 → OpenClaw（`@tencent-weixin/openclaw-weixin`）→ `cardinal-bridge` 插件 → 枢机 | `http`（`/openclaw` 端点） |
| Telegram（官方 Bot API） | Telegram → 枢机长轮询适配器（无需公网地址） | `telegram` |
| 企业微信自建应用（可选备选） | 企微回调 → 枢机 | `wecom` |
| 人工排查 / 其他平台 | HTTP POST `/message` | `http` |

命令识别在 OpenClaw 插件里完成（`before_agent_reply` 钩子，命中命令不走模型），
发送者 ID 传至枢机，由枢机白名单终审。插件通过 `message_received` 观察钩子获取发送者
（reply 钩子的 ctx 不带 senderId），解析不到时 fail-closed——桥会拒绝。

## 本仓库包含什么

| 目录 | 内容 |
| --- | --- |
| `packages/wechat-bridge/` | 命令路由（Node，零第三方依赖）：allowFrom 白名单、六条命令协议、危险命令二次确认、Telegram 长轮询适配器、企业微信回调加解密（备选）、JSONL 审计、限流、Bearer 端点鉴权 |
| `packages/openclaw-cardinal-plugin/` | OpenClaw 插件（TypeScript）：`message_received` + `before_agent_reply` 双钩子，把 Cardinal 命令转给枢机，不调模型 |
| `packages/hermes-sidecar/` | Hermes 心跳 Sidecar（Python 仅标准库）：generic 协议心跳、RPC→systemd 状态退化、重试退避、鉴权快速失败、SIGTERM 优雅退出 |
| `deploy/` | docker-compose、Dockerfile、systemd 加固单元、logrotate、环境变量模板、安装脚本（含启动前自检与卸载） |
| `test/` | Mission-Control 测试桩 + Telegram 测试桩 + T1–T14 端到端验收脚本（`node test/e2e.js`） |

## 安全红线（实现即约束）

- 命令入口白名单 `WECHAT_ALLOW_FROM` / `TELEGRAM_ALLOW_FROM`：只接受本人，其余一律拒绝（含审计留痕）
- 危险命令（`/dispatch` 等）60 秒内 `/confirm <token>` 二次确认后才执行，令牌一次性、仅发起人可用
- HTTP 端点 Bearer 鉴权 `BRIDGE_TOKEN`：配置后 `/openclaw` 与 `/message` 无令牌一律 401
- 默认拒绝绑定 `0.0.0.0` / `::`（红线：不暴露公网），需显式 `ALLOW_PUBLIC_BIND=1` 才放行
- 审计默认开启（`audit.jsonl`，0600 权限、10MB 轮转 + logrotate 兜底），显式 `AUDIT_LOG=none` 才关闭
- 请求体上限 1MB（超限 413 后断链），坏连接不会打崩进程
- 每发送者限流（默认 60 条/分、突发 20），防插件重试风暴打爆控制面
- 密钥只走环境变量 / EnvironmentFile，`chmod 600`，不入库、不入镜像
- 服务以最小权限专用账号运行，`NoNewPrivileges` + `ProtectSystem=strict`，禁止 root 常驻；容器 `read_only` + `cap_drop: ALL`

## 命令协议（微信 / Telegram 直接发文本）

| 命令 | 含义 | 管理面动作 |
| --- | --- | --- |
| `/ping` | 链路自检 | 固定返回 pong + 时间戳 |
| `/list` | 全部 Agent 状态 | `GET /api/agents` |
| `/status <id>` | 单个 Agent 详情 | `GET /api/agents/<id>` |
| `/tasks <id>` | 最近任务 | `GET /api/agents/<id>/tasks` |
| `/cost` | Token 成本汇总 | `GET /api/costs/summary` |
| `/dispatch <id> <任务>` | 下发任务（需二次确认） | `POST /api/tasks` |
| `/confirm <token>` | 确认执行待确认的危险命令 | — |
| `/help` | 帮助 | — |

输入会做归一化：中文输入法全角斜杠 `／ping`、零宽字符、连续空白都能正确识别。
回复按 **UTF-8 字节数**（1500）截断——中文 1 字 3 字节，比按字符数更贴近微信 2048 字节上限。

## 快速开始（本地 3 分钟跑通验收）

```bash
# 1. 单测：bridge 77 项 + sidecar 21 项 + OpenClaw 插件 22 项
npm test

# 2. 端到端验收 T1–T14（mock 控制面 + mock Hermes + mock Telegram + 真 sidecar 子进程 + 真 bridge）
npm run test:e2e

# 3. 手动起一套玩
node test/mock-mission-control.js 3000 &          # 假控制面
MC_BASE=http://127.0.0.1:3000 MC_API_KEY=test-key \
  WECHAT_ALLOW_FROM=me BRIDGE_TOKEN=dev-token \
  ADAPTER=http PORT=8080 \
  node packages/wechat-bridge/src/cli.js &        # 命令路由（HTTP 适配器）
curl -s -XPOST localhost:8080/message -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-token' \
  -d '{"from":"me","text":"/ping"}'               # → {"reply":"pong · ..."}
curl -s localhost:8080/healthz                    # → ok
curl -s localhost:8080/statsz                     # → 计数快照
```

Telegram 实跑：

```bash
MC_BASE=http://127.0.0.1:3000 MC_API_KEY=test-key \
  TELEGRAM_ALLOW_FROM=123456789 TELEGRAM_BOT_TOKEN=<BotFather 令牌> \
  ADAPTER=telegram node packages/wechat-bridge/src/cli.js
```

启动前只想校验配置（不启动服务）：`node packages/wechat-bridge/src/cli.js --check`。

## 部署

见 `deploy/`：

```bash
cd deploy
cp .env.example .env 2>/dev/null || true          # 控制面变量（MC_API_KEY 等）
cp env/wechat-bridge.env.example env/wechat-bridge.env && chmod 600 env/wechat-bridge.env
docker compose up -d                              # 控制面 + HTTP 路由 + Telegram 路由
```

Hermes 主机上用 `sudo deploy/install.sh` 装 Sidecar 与桥（含启动前自检、logrotate）；
卸载用 `sudo deploy/install.sh --uninstall`。
OpenClaw 主机按 `packages/openclaw-cardinal-plugin/README.md` link 插件并配置微信 ClawBot。
完整 11 阶段手册：[部署手册](https://osome.work/cardinal-plan/docs/runbook.html)。

## 测试现状（每次提交由 CI 复跑）

- `wechat-bridge`：77 项 `node:test`（白名单 / 二次确认 / 审计与轮转 / 限流 / HTTP 鉴权与韧性 / 企业微信回调加解密往返 / Telegram 长轮询 / 配置与公网绑定红线 / MC 客户端重试）
- `hermes-sidecar`：21 项 `unittest`（心跳报文与鉴权头、401 快速失败、500 重试、systemd 退化、CLI 退出码、dry-run、退避抖动）
- `openclaw-cardinal-plugin`：22 项 `node:test` + 对真实 openclaw SDK 的 `tsc --noEmit` 零错误
- `e2e`：T1–T14 全过（链路 / 安全 / 端点鉴权 / 令牌一次性 / 状态 / 告警 / 恢复 / 计量 / 调度 / 韧性 / Telegram / 审计留痕 / 企微备份链路）
- CI 五个 job：bridge / sidecar / plugin / deploy 清单校验 / e2e

## 许可

MIT
