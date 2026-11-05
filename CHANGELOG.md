# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号语义化。

## [0.4.0] - 2026-11-05

主题：**把控制面补上，让链路真的能跑**。新增自研 Mission-Control（SQLite 持久），
并把上一版遗留的三个「真机上才会咬人」的缺陷修掉。

### 新增：Mission-Control（控制面）

此前控制面是第三方镜像 + 内存测试桩——`/list` `/status` `/tasks` `/cost` `/dispatch`
没有持久真相，bridge 一重启数据就没了。现在仓库里有了完整的控制面：

- `packages/mission-control/`：Node 仅标准库 + `node:sqlite`（需 Node 22.5+，推荐 24）
- 端点：`GET /api/agents`、`GET /api/agents/<id>`、`GET /api/agents/<id>/tasks`、
  `GET /api/costs/summary`、`POST /api/agents/heartbeat`、`POST /api/tasks`，
  外加工人协议 `POST /api/tasks/<id>/claim` 与 `POST /api/tasks/<id>/complete`
- 任务状态机 `pending → running → done|failed|cancelled`；重复 claim / 对已完成任务
  complete 返回 409 + 当前状态，不静默成功
- 成本计量合并两个来源：心跳 `detail.usage`（累计）与任务完成时的 `tokens`/`costUsd`，按 Agent 分组
- **读路径心跳超时纠偏**：`MC_STALE_SEC`（默认 900）内没有新心跳的 Agent，`/list` 一律显示
  `offline`，并附 `reportedStatus` 与 `stale: true`——否则面板会把早已死掉的 Agent
  显示成最后一份心跳自称的 online
- 与桥同款的红线：`MC_API_KEY` 必填（Bearer，constant-time 比较）、默认拒绑通配地址、
  审计默认开启且**只记元数据不记请求体**（任务标题可能含机密）、每 IP 令牌桶限流、
  请求体上限 413、裸 TCP 断链不打崩进程、`--check` / `--version` / `--help`、SIGTERM 优雅停机
- 每 Agent 任务条数上限裁剪（`MC_TASKS_PER_AGENT`），超长任务标题截断并回带 `titleTruncated`

### 修复（真机验证过的）

- **心跳时间单位混用**：generic 协议的 `reportedAt` 是**秒**（`int(time.time())`），
  控制面却拿它和 `Date.now()`（毫秒）比大小——「心跳超时纠偏」会把刚上报的 Agent
  立刻判成离线，整条微信主线在 `/list` 里永远是 offline。现按量级换算成毫秒。
- **Hermes 是用户级 systemd 单元，sidecar 却只在系统作用域查**：
  `systemctl is-active hermes-gateway.service`（不带 `--user`）返回退出码 3「没有这个单元」，
  sidecar 于是把活着的 Hermes 报成 offline。新增 `SYSTEMD_SCOPE=auto|system|user`：
  auto 先查系统作用域，遇「无此单元」自动改查 `--user`。本机已实测：修复前 offline，修复后
  `{"source":"systemd","scope":"user","state":"active"}`。
- **systemd 的 `StartLimitIntervalSec` / `StartLimitBurst` 写在 `[Service]` 段**：
  这两个键属于 `[Unit]` 段，写在 `[Service]` 里被静默忽略——「启动即失败不要无限重启」
  这道防护一直是空转。六个单元文件全部改正，`systemd-analyze verify` 现已无警告。


### 新增：Telegram 第二入口（实跑接线）

- `deploy/env/wechat-bridge-telegram.env(.example)`：Telegram 入口独立环境文件——
  与 HTTP/微信入口分开跑，白名单、审计文件、令牌互不干扰（两个适配器同时运行）
- `deploy/systemd-user/wechat-bridge-telegram.service`（用户作用域）与
  `deploy/systemd/wechat-bridge-telegram.service`（系统作用域，`User=wechat-bridge`）：
  一个进程只跑一个适配器，所以 Telegram 入口必须是独立单元；它与 HTTP 入口共用
  同一账号、同一份代码与日志目录，只换环境文件——少一个账号就少一处要维护的权限
- `deploy/wait-telegram-sender.sh`：不知道自己的 Telegram 数字 user_id 时跑它——
  给机器人发一句话，脚本自动把 ID 写进 `TELEGRAM_ALLOW_FROM`、装并起服务、
  回一条确认消息。令牌从环境文件读，换机器人只改一处
- `install.sh` 拆出 `SERVICES`（4 个 systemd 单元）与 `COMPONENTS`（3 个落盘组件）：
  之前「接下来」那行提示 `systemctl enable --now wechat-bridge-telegram`，
  而这个单元从来没被安装过——照做会得到 `Failed to connect to bus` / 单元不存在。
  自检清单现在也覆盖 Telegram 环境文件（白名单占位值、权限 600）
- docker-compose 的 Telegram 服务改用独立 env 文件，并删掉 `environment` 里的
  `TELEGRAM_BOT_TOKEN` 覆盖——compose 的 `environment` 优先级高于 `env_file`，
  留着它等于要求同一个密钥在 `deploy/.env` 里再存一份
- `logrotate/wechat-bridge` 从单文件改为 `/var/log/wechat-bridge/*.jsonl`：
  之前只轮转 `audit.jsonl`，Telegram 入口的 `telegram-audit.jsonl` 没人管

### 修复：配置装配的两类「配了却没生效」

- `validateConfig` 现在对**当前适配器的白名单为空、另一个入口却配了**的情况给警告。
  一个进程只跑一个适配器，白名单取并集不会越权（微信消息到不了 Telegram 适配器），
  但「配了另一个入口、当前入口是空的」会让服务正常启动、然后每一个真实用户都被拒——
  比启动失败更难发现
- `TELEGRAM_VALIDATE_TOKEN` / `TELEGRAM_DRAIN_BACKLOG` 拼成 `yes` / `true` / `on`
  时不再静默按默认值走（令牌错了不校验、积压消息该丢不丢），启动即报错

### 部署

- 新增 `deploy/Dockerfile.mission-control`（Node 24、非 root、fetch 健康检查）、
  `deploy/systemd/mission-control.service`、`deploy/logrotate/mission-control`、
  `deploy/env/mission-control.env.example`
- `deploy/systemd-user/`：一整套**用户作用域**单元（本机 Hermes 与 OpenClaw 都是用户单元，
  枢机跟它们同规格；`%h` 展开，EnvironmentFile 直接指向仓库里的 env 文件）
- `docker-compose.yml` 的控制面从第三方镜像改为构建本仓库代码，并加上
  `read_only` / `cap_drop: ALL` / `no-new-privileges` / 数据卷
- `install.sh` 增加控制面组件、Node 版本前提检查（`node:sqlite`）、
  `MC_API_KEY` 占位值自检、`/var/lib/mission-control` 750 权限
- `deploy/.gitignore`：`*.env` 一律忽略、`*.env.example` 例外——密钥不会因为手滑入库

### 测试

- 新增 `packages/mission-control`：**92** 项 `node:test`
- bridge 77 → **80**（`/dispatch` 打到未注册 Agent 时提示「未找到 Agent」而不是暴露 404；
  标题被控制面截断时给出提示）
- sidecar 21 → **25**（用户级单元自动发现、显式作用域、非法作用域拒绝、缺单元名）
- e2e 15 → **24** 项：新增 T15–T22 打**真控制面**——mission-control 与 sidecar 都以子进程
  运行（走真实 CLI 与环境变量解析），验证 Bearer 鉴权、心跳落库、`/dispatch` 与未注册 Agent、
  心跳超时纠偏、claim/complete 计量、**bridge 重启后 Agent 与任务都还在**、审计不含 API Key
- CI 五个 job → **六个**：新增 `mission-control`（Node 24，含 `--check` 退出码断言），
  e2e 升级到 Node 24 并改名 T1-T22；deploy job 增加 `docker compose config` 解析

## [0.3.0] - 2026-11-05

主题：**把红线从「写了」变成「验过」**——补上生产链路上真实会咬人的缺陷，并让每条红线都有可复跑的验证。

主题：**把红线从「写了」变成「验过」**——补上生产链路上真实会咬人的缺陷，并让每条红线都有可复跑的验证。

### 修复（会在生产咬人的）

- **OpenClaw 插件拿不到发送者 ID**：`before_agent_reply` 的 ctx 只有 sessionKey 一类会话字段，没有 senderId，
  原实现 `String(ctx.senderId ?? '')` 永远得到空串 → 枢机白名单终审判为陌生人 → 微信主线全部「拒绝访问」。
  改为同时挂 `message_received` 观察钩子按 sessionKey 记录发送者，并保留 prepared prompt 前缀兜底；
  解析不到时 fail-closed（桥侧拒绝）。
- **插件误劫持普通对话**：原命令识别用「行内任意位置匹配」，用户说「看看 /list 怎么用」整条消息会被枢机截走。
  改为「某一行以 `/命令词` 开头」才命中（仍支持 `[微信 · DM] user123:` 前缀与同行 `前缀: /list` 形态）。
- **审计默认关闭**：未配 `AUDIT_LOG` 时审计静默丢弃——与「全量审计」红线相悖。现默认写 `audit.jsonl`，
  显式 `AUDIT_LOG=none` 才关闭，且文件权限 0600。
- **`/tasks` 之外的 404 文案不友好**：`/status` 对不存在的 Agent 现在回「未找到 Agent：<id>」。
- **回复按字符数截断会超微信上限**：中文 1 字 3 字节，1500 字符可能是 4500 字节。改为按 UTF-8 字节截断。
- **超大请求体处理会打断连接而不给响应**：原来直接 `req.destroy()`，客户端只看到连接重置。改为先写 413 再断链。
- **未捕获的 req/res error 事件可打崩进程**：裸 TCP 写半个请求就断开的场景下现在服务存活（有回归测试）。
- **确认令牌被他人误消费**：发起人不一致的确认原来会销毁令牌。现在只拒绝、不销毁。

### 新增（红线与韧性）

- HTTP 端点 Bearer 鉴权 `BRIDGE_TOKEN`（配置后 `/openclaw`、`/message` 无令牌 401，constant-time 比较）——
  插件侧 `cardinalToken` 从此真正生效。
- 公网绑定防护：默认拒绝 `HOST=0.0.0.0` / `::`，需显式 `ALLOW_PUBLIC_BIND=1`。
- 每发送者令牌桶限流（`RATE_LIMIT_PER_MIN` / `RATE_LIMIT_BURST`，被限流也进审计）。
- 审计轮转（`AUDIT_MAX_BYTES` / `AUDIT_KEEP`）+ `deploy/logrotate/wechat-bridge`。
- Mission-Control 客户端：GET 在网络错误 / 5xx / 408 / 429 时重试（`MC_RETRY`），**POST 绝不重试**（避免重复下发任务）。
- 企业微信回调：时间窗校验挡重放（`WECOM_TIMESTAMP_WINDOW_SEC`）、XML 实体反转义、解密内容长度边界检查。
- JSON 结构化日志（journald 友好）+ `/healthz` + `/statsz` 计数快照。
- CLI：`--help` / `--version` / `--check`（只校验配置不启动）+ SIGTERM/SIGINT 优雅停机。
- Sidecar：401/403 以退出码 4 结束（配合 systemd `StartLimit` 变可见失败，而非无声刷日志）、
  退避加抖动、`--dry-run` / `--interval`、报文带 `reportedBy` 与 pid、User-Agent。
- 部署：compose 增加 healthcheck / `read_only` / `cap_drop: ALL` / `no-new-privileges` / 审计日志卷；
  Dockerfile 增加 HEALTHCHECK 与非 root；install.sh 增加启动前自检（环境文件在位、权限 600、白名单非占位值）、
  logrotate 安装与 `--uninstall`；systemd 增加 StartLimit / TimeoutStopSec / PYTHONUNBUFFERED。

### 测试

- bridge 34 → **77** 项；sidecar 14 → **21** 项；插件 11 → **22** 项；e2e 9 → **15** 项（T10–T14）。
- CI 增加 `deploy` job：`bash -n`、`install.sh --dry-run`、`systemd-analyze verify`，并对全部源码做 `node --check`。

### 兼容性

- 命令协议、回复文案格式、REST 路径均未变化（`/cost`、`/status` 仍返回 JSON，e2e 直接解析）。
- 新增环境变量全部有默认值，旧配置可直接运行；`BRIDGE_TOKEN` 未配置时行为与之前一致（无鉴权），但会打印警告。

[0.3.0]: https://github.com/bit-cook/shuji/compare/v0.2.0...v0.3.0
[0.4.0]: https://github.com/bit-cook/shuji/compare/v0.3.0...v0.4.0
