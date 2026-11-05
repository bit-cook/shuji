# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号语义化。

## [0.3.0] - 2026-11-05

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
