# 枢机 · Cardinal

> **Everything hinges on it.** 万事，系于此枢。

枢机是 **Agenos** 项目的控制面实现：把散落在各主机上的 Agent 收进一个控制点——下令，全局回报。
项目计划与文档（交接文档 / 部署手册 / 对话全记录）在另一个仓库：[bit-cook/cardinal-plan](https://github.com/bit-cook/cardinal-plan)（站点：https://osome.work/cardinal-plan/）。

## 入口：微信（iLink 原生）+ Telegram + 企业微信 + HTTP

| 入口 | 路径 | 适配器 |
| --- | --- | --- |
| 微信（个人号，官方 ClawBot/iLink） | 微信 → 枢机 `weixin` 适配器（**枢机自己实现的 iLink 客户端，不需要装 OpenClaw**） | `weixin` |
| Telegram（官方 Bot API） | Telegram → 枢机长轮询适配器（无需公网地址） | `telegram` |
| 企业微信自建应用（可选备选） | 企微回调 → 枢机 | `wecom` |
| OpenClaw 插件 / 人工排查 | HTTP POST `/message` 或 `/openclaw` | `http` |

微信入口与 Telegram 入口一样是枢机自己的进程：扫码登录拿到机器人令牌后持久化到状态文件
（0600），之后 systemd 单元只做长轮询，不需要人在场，也不依赖任何 Agent 宿主。
协议细节（长轮询、uint64 消息 ID 的保精度解析、服务端同步游标 `get_updates_buf`）
在 `packages/wechat-bridge/src/ilink.js` 的注释里写全了。

**加一个新通讯工具**就是加一个适配器文件：在 `packages/wechat-bridge/src/adapters/` 下
新建 `xxx.js`，导出 `createXxxAdapter({ router, ... })` 并实现 `start()/stop()` 与
`router.handle(text, fromUser, { channel })` 一个调用；然后在 `src/index.js` 的
`ADAPTERS` 里加一个名字、在 `createBridgeFromEnv` 里加一个分支。白名单、八条命令协议、
危险命令二次确认、审计、限流全都在 router 里，适配器一条都不重复实现。

## 本仓库包含什么

| 目录 | 内容 |
| --- | --- |
| `packages/mission-control/` | 控制面（Node 仅标准库 + `node:sqlite`，需 Node 22.5+ / 推荐 24）：Agent 注册与心跳、任务下发/领取/回报、Token 成本计量、Bearer 鉴权、审计、读路径心跳超时纠偏、**只读网页面板** |
| `packages/wechat-bridge/` | 命令路由（Node ≥18）：allowFrom 白名单、八条命令协议、危险命令二次确认、**微信 iLink 原生长轮询**、Telegram 长轮询、企业微信回调加解密（备选）、JSONL 审计、限流、Bearer 端点鉴权。唯一第三方依赖是 `qrcode-terminal`（扫码登录在终端画二维码用） |
| `packages/openclaw-cardinal-plugin/` | OpenClaw 插件（TypeScript）：`message_received` + `before_agent_reply` 双钩子，把 Cardinal 命令转给枢机，不调模型。**可选项**——微信主线已由枢机自己的 `weixin` 适配器承担，这个插件只服务于仍想经 OpenClaw 转发的场景 |
| `packages/hermes-sidecar/` | Hermes 心跳 Sidecar（Python 仅标准库）：generic 协议心跳、RPC→systemd 状态退化（**自动识别 system / --user 作用域**）、重试退避、鉴权快速失败、SIGTERM 优雅退出 |
| `deploy/` | docker-compose、两个 Dockerfile、systemd 加固单元（系统作用域 + 用户作用域两套）、logrotate、环境变量模板、安装脚本（含启动前自检与卸载） |
| `test/` | Mission-Control 测试桩 + Telegram 测试桩 + iLink 测试桩 + T1–T26 端到端验收脚本（`node test/e2e.js`） |

## 四层链路

```
入口层    微信 iLink（原生）/ Telegram Bot API / 企业微信回调 / HTTP
   ↓
网关层    wechat-bridge：命令路由、白名单终审、危险命令二次确认、限流、审计
   ↓
控制面    mission-control：Agent 注册/心跳、任务队列、成本计量（SQLite 持久）、网页面板
   ↓
节点层    Hermes（心跳 sidecar）/ 其他（generic 协议）
```


## 安全红线（实现即约束）

- 命令入口白名单 `WECHAT_ALLOW_FROM` / `TELEGRAM_ALLOW_FROM`：只接受本人，其余一律拒绝（含审计留痕）
- 危险命令（`/dispatch` 等）60 秒内 `/confirm <token>` 二次确认后才执行，令牌一次性、仅发起人可用
- 控制面 `MC_API_KEY` 必填：无鉴权的控制面等于把全部 Agent 交给同主机任何账号
- HTTP 端点 Bearer 鉴权 `BRIDGE_TOKEN`：配置后 `/openclaw` 与 `/message` 无令牌一律 401
- 默认拒绝绑定 `0.0.0.0` / `::`（红线：不暴露公网），需显式 `ALLOW_PUBLIC_BIND=1` 才放行
- 审计默认开启（`audit.jsonl`，0600 权限、10MB 轮转 + logrotate 兜底），显式 `AUDIT_LOG=none` 才关闭；
  控制面审计**只记元数据**（方法/路径/状态/耗时/IP），不记请求体——任务标题可能含机密
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
# 0. 单测：bridge 133 项 + 控制面 125 项 + sidecar 25 项 + 插件 22 项
npm test

# 1. 端到端验收 T1–T26（mock 控制面 + mock Hermes + mock Telegram + mock iLink
#    + 真 sidecar 子进程 + 真 bridge；T15–T26 另起一节打真控制面：真 SQLite + 真 CLI 子进程）
npm run test:e2e

# 2. 手动起一套玩
MC_API_KEY=$(openssl rand -hex 24) node packages/mission-control/src/cli.js &   # 控制面
MC_BASE=http://127.0.0.1:3000 MC_API_KEY=<上面的值> \
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
MC_BASE=http://127.0.0.1:3000 MC_API_KEY=<控制面的值> \
  TELEGRAM_ALLOW_FROM=123456789 TELEGRAM_BOT_TOKEN=<BotFather 令牌> \
  ADAPTER=telegram node packages/wechat-bridge/src/cli.js
```

微信实跑（先扫码登录，再长轮询；**不需要装 OpenClaw**）：

```bash
mkdir -p /tmp/cardinal-wx
# 一次性交互步骤：终端里画出二维码，用手机微信扫
WECHAT_STATE_FILE=/tmp/cardinal-wx/state.json WECHAT_ALLOW_FROM=先随便填一个占位 \
  node packages/wechat-bridge/src/cli.js --adapter weixin --login
# 登录成功后把打印出来的「扫码账号 ID」填进 WECHAT_ALLOW_FROM，然后：
MC_BASE=http://127.0.0.1:3000 MC_API_KEY=<控制面的值> \
  WECHAT_STATE_FILE=/tmp/cardinal-wx/state.json WECHAT_ALLOW_FROM=<扫码账号ID> \
  ADAPTER=weixin node packages/wechat-bridge/src/cli.js
```

网页面板（只读，挂在控制面同一个端口上）：

```bash
# 控制面起着就行，浏览器打开：
#   http://127.0.0.1:3000/panel
# 用 MC_API_KEY 换一个会话 Cookie（HttpOnly + SameSite=Strict，12 小时有效）。
# 面板只读：Agent 状态、任务计数、Token 与成本汇总；写操作仍走命令入口的二次确认。
# 关掉它：MC_PANEL=0
curl -s localhost:3000/panel | head -5
```

启动前只想校验配置（不启动服务）：`node packages/wechat-bridge/src/cli.js --check`、
`node packages/mission-control/src/cli.js --check`。

## 部署

见 `deploy/`：

```bash
cd deploy
for c in mission-control wechat-bridge wechat-bridge-telegram wechat-bridge-weixin hermes-sidecar; do
  cp env/$c.env.example env/$c.env && chmod 600 env/$c.env
done
docker compose up -d        # 控制面 + HTTP 路由 + Telegram 路由 + 微信路由
```

`deploy/env/*.env` 已被 gitignore（含密钥），只有 `*.env.example` 入库。
compose 与控制面数据库目录由各组件自己创建。微信入口的令牌不在 env 文件里，
而在 `/var/lib/wechat-bridge-weixin/state.json`（0600），由扫码登录生成——
容器里做不了扫码，所以要先在宿主机上跑一次 `--login` 再把那个卷挂进来。

Hermes 主机上用 `sudo deploy/install.sh` 装四件套（含启动前自检、logrotate）；
卸载用 `sudo deploy/install.sh --uninstall`。
微信入口装好后按安装脚本末尾的提示跑一次扫码登录，再 `systemctl enable --now wechat-bridge-weixin`。

本机（Hermes 与 OpenClaw 都以 **systemd 用户单元**运行的机器）可用另一套：

```bash
for u in mission-control wechat-bridge wechat-bridge-telegram wechat-bridge-weixin hermes-sidecar; do
  cp deploy/systemd-user/$u.service ~/.config/systemd/user/cardinal-$u.service
done
systemctl --user enable --now cardinal-mission-control \
  cardinal-wechat-bridge cardinal-wechat-bridge-telegram cardinal-hermes-sidecar

# 不知道自己的 Telegram 数字用户 ID？跑这个，给机器人发一句话，它自动补白名单并起服务：
#   bash deploy/wait-telegram-sender.sh
```

完整 11 阶段手册：[部署手册](https://osome.work/cardinal-plan/docs/runbook.html)。

## 测试现状（每次提交由 CI 复跑）

- `wechat-bridge`：133 项 `node:test`（白名单 / 二次确认 / 审计与轮转 / 限流 / HTTP 鉴权与韧性 / 企业微信回调加解密往返 / Telegram 长轮询 / 配置与公网绑定红线 / MC 客户端重试 / **启动即校验、单入口白名单漏配、请求体按字节判限、Telegram 群聊忽略、审计文件重建后仍 0600、iLink 协议保精度解析与无损 ID、微信登录状态机全分支、微信长轮询与游标回传**）
- `mission-control`：125 项 `node:test`（报文归一化含秒/毫厘单位 / 心跳超时纠偏 / 任务状态机与重复领取 / 每 Agent 任务与心跳流水裁剪 / detail 大小上限 / 成本合并 / 持久化 / 路由匹配 / Bearer / 413·429·裸 TCP 韧性 / 审计不含密钥 / 限流器与计数器的有界性 / **网页面板：会话签发与校验、Cookie 防篡改、过期即失效、登录限流、只读边界、MC_PANEL=0 整体关闭、**面板端点一律绝对路径（`/panel/` 带尾斜杠时不会拼成 `/panel/panel/…`）、登录失败按状态码给出准确原因**）
- `hermes-sidecar`：25 项 `unittest`（心跳报文与鉴权头、401 快速失败、500 重试、systemd 退化**含用户级单元自动识别**、CLI 退出码、dry-run、退避抖动）
- `openclaw-cardinal-plugin`：22 项 `node:test` + 对真实 openclaw SDK 的 `tsc --noEmit` 零错误
- `e2e`：T1–T26 全过（链路 / 安全 / 端点鉴权 / 令牌一次性 / 状态 / 告警 / 恢复 / 计量 / 调度 / 韧性 / Telegram / 微信 iLink / 审计留痕 / 企微备份链路 / **真控制面：鉴权、心跳落库、dispatch 与未注册 Agent、超时纠偏、claim-complete 计量、重启后持久化、网页面板会话与只读边界**）
- CI 六个 job：bridge / 控制面（Node 24）/ sidecar / plugin / deploy 清单校验 / e2e

## 许可

MIT
