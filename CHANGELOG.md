# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号语义化。

## [0.6.1] - 2026-11-05

主题：**面板在 `/panel/`（带尾斜杠）下完全不可用**。用户照地址栏自动补全的尾斜杠
打开面板，登录必然失败，而报错指向「API Key 不正确」——一个与真实原因无关的方向。

全量回归：306 项单测（133 桥 + 126 控制面 + 25 Sidecar + 22 插件）+ T1–T26 端到端，CI 六 job 全绿。

### 修复

- **面板前端用相对路径请求自己的端点**：页面里写的是 `fetch('panel/login')`，浏览器
  按当前文档地址解析，访问 `/panel` 时得到 `/panel/login`（碰巧正确），访问 `/panel/`
  时得到 `/panel/panel/login`——服务端没有这条路，404。四个端点（session / login /
  snapshot / logout）全中，表现为「密钥怎么输都不对」
- **登录失败不区分状态码，一律显示「API Key 不正确」**：404（路径错）、503（服务端
  没配密钥）与真正的 401 是三种不同的事，处理方式也不同。现在 401 才说密钥不对，
  429 说尝试过于频繁并给出等待秒数，503 说服务端未配置，其余按 HTTP 码报出
- **服务端此前就接受 `/panel/`**（`PANEL_PATH` 与 `PANEL_PATH + '/'` 都给页面），所以
  页面能正常渲染、只有接口全挂——这种「能打开但不能用」比直接 404 更难定位
- 顺带收敛：页面不再出现 `MC_API_KEY` 这个服务端环境变量名，排障信息说「服务端未配置
  密钥」就够定位
- 测试加固：`server.test.js` 里 413 那条断言的墙上时钟超时从 3 秒放到 15 秒。它等的
  是「服务端收 body 之前就回 413」，与负载无关，3 秒在机器繁忙时会偶发红

### 健壮性：面板载入卡死时给用户一个出口

- 页面初始内容是「正在载入…」，整个面板由 JS 渲染。`render()` 因任何原因没跑完
  （脚本被浏览器插件拦截、请求挂起、SSH 端口转发没建立、禁用了 JavaScript），
  用户会被永久留在这句话上——看不出该重试还是该换浏览器，比报错更糟
- 现在 8 秒后仍未离开初始状态就替换为带原因说明与「重试」按钮的提示；同时补
  `<noscript>`：禁用 JavaScript 时直接说明面板需要它，而不是留一句「正在载入…」

## [0.6.0] - 2026-11-05

主题：**微信入口改为枢机原生实现，并加上网页面板**。两条都不新增依赖式的前提——
微信不再以「先装好 OpenClaw」为条件；面板不新开端口、不引入第二条写路径。

全量回归：255 项单测 + T1–T26 端到端，CI 六 job 全绿。

### 新增：微信（iLink）入口，枢机自己实现

- **`packages/wechat-bridge/src/ilink.js`**：iLink bot 协议客户端（HTTP + 长轮询 +
  Bearer）。参照 OpenClaw 官方微信通道（`@tencent-weixin/openclaw-weixin`）的连接方式
  直接实现，不依赖、也不需要安装 OpenClaw。端点：`get_bot_qrcode` /
  `get_qrcode_status` / `getupdates` / `sendmessage`；请求头带
  `iLink-App-Id`、`iLink-App-ClientVersion`（uint32 的 `0x00MMNNPP` 编码）、
  `AuthorizationType`、`X-WECHAT-UIN`
- **`src/adapters/weixin.js`**：适配器，形状与 Telegram 适配器同构（出站长轮询、
  指数退避、优雅停机），因此可以直接插进 `createBridgeFromEnv`
- **两个必须照做的协议细节，错了都是静默故障**：
  - `message_id` / `msg_id` / `svr_id` 是 uint64，超出 2^53 后 JS number 会丢精度。
    对端 JSON 里它们是裸数字，直接 `JSON.parse` 就把 ID 改了。`parseLossless()`
    先把这些字段替换成字符串再解析（只改真正的对象属性，不碰字符串内容里的同名字样）
  - `get_updates_buf` 是服务端同步游标，必须原样回传并持久化。丢了它服务端会重放
    积压——表现为把用户下线期间发的命令重新执行一遍
- **扫码登录 `--login`**（`src/ilink-login.js` + CLI）：一次性交互步骤，状态机逐分支
  照对端实际返回的 status 处理（`wait` / `scaned` / `need_verifycode` / `expired` /
  `verify_code_blocked` / `binded_redirect` / `scaned_but_redirect` / `confirmed`）。
  两处不看源码就会踩：`scaned_but_redirect` 带 `redirect_host`，接入点必须切过去，
  否则表现为扫了码但一直没下文；`binded_redirect` 表示这个机器人已绑到枢机名下、
  服务端不再发新令牌，这属于成功而不是失败
- 登录产物（令牌、接入点、同步游标）落 `WECHAT_STATE_FILE`，原子写入 + 0600。
  服务端下发的 `ilink_user_id`（扫码账号 ID）会原样打印，直接抄进 `WECHAT_ALLOW_FROM`
- 群聊（`group_id` 非空）显式忽略：机器人被拉进群后，陌生成员会触发「拒绝访问」并回
  在群里，既刷屏又等于向全群公告白名单的存在。图片/语音/文件同样显式忽略（命令协议
  是纯文本）
- `ret != 0` 的服务端应答按异常抛出交给退避，不当作「没有消息」——否则令牌失效、
  账号被封这类故障表现为「机器人在线但谁都不理」
- 部署：`deploy/systemd/wechat-bridge-weixin.service`、用户作用域同款单元、
  `deploy/env/wechat-bridge-weixin.env.example`、`install.sh`（新单元 + 令牌目录 700 +
  依赖安装 + 卸载清理）、docker-compose 服务与卷、Dockerfile 安装生产依赖
- 新增唯一第三方依赖 `qrcode-terminal@0.12.0`（扫码登录在终端画二维码用，
  OpenClaw 官方微信通道同一个库）；CI 的 bridge job 增加 `npm ci`

### 新增：网页面板（只读）

- **`packages/mission-control/src/panel.js` + `panel-page.js`**：挂在控制面同一个 HTTP
  服务上，不新开端口、不新开监听面，因此自动继承默认只绑 `127.0.0.1`、每 IP 令牌桶
  限流、全量审计三件事
- **鉴权**：浏览器不方便每次带头，所以用一次性交换——`POST /panel/login` 拿
  `MC_API_KEY` 换一个 HttpOnly + SameSite=Strict 的会话 Cookie。Cookie 是
  `<会话号>.<过期时间>.<HMAC>`，HMAC 用 `MC_API_KEY` 对前两段签名：改任何一段签名
  就对不上；过期时间在签名里，时钟到了服务端就不认；不知道 `MC_API_KEY` 伪造不出
  合法 Cookie。全程 constant-time 比较，登录失败按 IP 限流（默认每 IP 每分钟 5 次，
  限流后连正确密钥也进不去——这正是防爆破想要的行为）
- **只读**：面板只暴露 GET 快照，不提供下发任务、领取、回报的入口。写操作一律回到
  命令入口走危险命令二次确认（60 秒一次性令牌、仅发起人可用、全量审计）。面板不引入
  第二条写路径，也就不引入 CSRF 面
- 快照只回渲染所需字段：Agent 心跳详情里可能带命令原文，不进浏览器
- 配置：`MC_PANEL`（0 关）、`MC_PANEL_SESSION_TTL_MS`（默认 12 小时）、
  `MC_PANEL_LOGIN_PER_MIN`
- 可视化遵循数据可视化规范：深浅两套色值都是挑选出来的（不是反转浅色）、状态色固定
  且必须图标 + 文字同时出现（浅色面上的告警黄对比度只有 1.79:1，不允许只靠颜色传达
  状态）、文字一律用文本色不穿数据色、单序列图表不放图例而每条柱子在端头直接标数值、
  必须有一份表格视图、表格用 tabular-nums

### 修复

- **`mission-control` 的 `--version` 永远是硬编码的 `0.4.0`**：cli.js 里
  `require('./package.json')` 实际解析到 `src/package.json`（不存在），每次都走 catch
  退回内置版本号，发版改了 package.json 也不见生效
- `getUpdates` 遇到服务端 `ret != 0` 时当作空响应继续轮询（见上）
- iLink 客户端构造时传入的 `token` 此前没有作为默认鉴权头使用，导致 `getUpdates` 等
  调用发出的请求不带 `Authorization`

## [0.5.0] - 2026-11-05

主题：**常驻系统的体积与「配了却没生效」**。这一版不动功能，专治两类只有跑久了
或只在真机上才暴露的问题：无界增长（内存 / 数据库），以及配置错了服务照常启动。

全量回归：252 项单测 + T1–T22 端到端，CI 六 job 全绿。

### 修复：配置错了服务照常启动（红线相关）

- **`createBridgeFromEnv` 启动前跑 `validateConfig`**。此前校验只存在于 `--check`，
  而 systemd / compose 起服务时没人会加那个参数——于是「telegram 适配器只配了微信
  白名单」这类错会以一个正常启动、然后拒绝每一个真实用户的形式存在，日志里一行
  提示都没有。现在 errors 直接抛（启动失败），warnings 进日志
- **当前适配器自己的白名单为空 → 启动即失败**（此前是警告）。一个进程只跑一个
  适配器，Telegram 消息只会到达 telegram 适配器；它自己的白名单为空，这个进程就
  永远服务不了任何真实用户。没有一种正当配置长这样，不该放它起来
- `TELEGRAM_VALIDATE_TOKEN` / `TELEGRAM_DRAIN_BACKLOG` 拼成 `yes` / `true` / `on`
  不再静默按默认值走，启动即报错
- `AUDIT_LOG` 告警此前只在 `adapter !== 'telegram'` 分支里，长轮询入口漏配时会把
  审计静默写进当前工作目录（用户级单元的 cwd 就是 `$HOME`）。现在对所有适配器生效
- `PORT=0`（内核挑空闲端口）放行并告警——它会在启动日志里打出真实端口，不属于
  「配了却没生效」；但生产环境写 0 几乎一定是笔误。非数字与越界仍然拒绝

### 修复：无界增长（常驻系统）

- **心跳流水 `heartbeats` 表此前只增不删**。控制面要长期常驻，按默认 300s 周期
  一年就是 ~10 万行/Agent，且每行都带一份 detail JSON。新增 `MC_HEARTBEATS_PER_AGENT`
  （默认 200，按 Agent 分别计数——一个话痨 Agent 不会冲掉别人的历史）；设 0 显式
  关闭清理并告警
- **心跳 `detail` 无大小上限**：一个失灵的 Agent（或恶意的）每周期塞一坨 JSON 就能
  把库撑爆。新增 `MC_MAX_DETAIL_BYTES`（默认 8KB），超限时保留可读摘要并打
  `_detailTruncated` 标记，而不是整条拒绝——拒绝会让 Agent 直接掉线，更糟
- **限流器的桶 Map 只插不删**，而键是调用方给的任意字符串（桥侧是发送者 ID，
  控制面侧是客户端 IP），两者都能被陌生人影响。现在带闲置清扫与硬上限
  `maxBuckets`；清扫只丢「已回满且闲置」的桶（满桶重建出来还是一满桶，不改变
  限流结果），正在生效的限流不会被清掉
- **计数器 `byRoute` / `byCommand` 的键无上限**，且其中一部分来自请求本身
  （未命中路由时用完整 path，最长 512 字节，发生在鉴权之前），而 `/statsz` 免鉴权
  ——扫描流量既能撑大 Map，又能把注入的字符串读回去。现在键数有硬上限，
  超出归并到 `*other` 并计数
- SQLite 数据库文件权限收到 0600（含 `-wal` / `-shm`）。目录级 750 是另一道防线，
  但「目录权限哪天被放宽了」不该顺带把 Agent 明细与任务标题送出去

### 修复：其他

- **Telegram 适配器现在只接私聊**。机器人一旦被拉进群，群里每个人的消息都会走到
  这里：陌生成员触发「拒绝访问」，而回复发往 `msg.chat.id`——也就是群。那既刷屏，
  又等于向全群公告「这机器人有白名单、谁不在名单里」
- 审计文件被外部删除后重建，不再沿用进程 umask（早先的 `ensured` 闩锁让重建文件
  停在 0644，审计里的用户 ID 与命令原文谁都能读）。改用 `appendFileSync` 的
  `mode` 选项——它只在新文件创建时生效，正好覆盖这条路径
- HTTP 适配器请求体上限此前按**字符串长度**累计，中文 1 字 3 字节，实际能放进
  声明上限三倍的量；而 Content-Length 那道是按字节判的，两边不同口径等于限幅
  没生效。改为按字节
- 确认令牌从 4 字节（32 bit）加到 6 字节（48 bit）——它是「知道它就能执行危险
  命令」的凭证，虽然 60s TTL + 仅发起人 + 限流已经堵住暴力破解，但没有理由省
  这 2 个字节
- 任务 ID 的随机部分从 `Math.random` 换成 `crypto.randomBytes`：任务 ID 是
  claim / complete 的口令，弱随机的种子可预测
- Telegram 积压丢弃的日志从 `dropped: N` 改为 `offsetAdvancedTo: N`。
  `offset=-1` 的语义是「只要最后一条更新」，所以 N 最多是 1，报个数会让人以为
  只丢了一条（行为一直是对的，只是日志不诚实）

### 测试

新增 21 项回归（bridge 90→97，控制面 101→108）：启动即校验、单入口白名单漏配、
AUDIT_LOG 对所有适配器生效、PORT=0、心跳流水保留上限（含按 Agent 分开计数）、
detail 截断、限流器有界性（含「不清正在生效的限流」）、计数器键数上限、
Telegram 群聊忽略、审计文件重建后仍 0600、请求体按字节判限。

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
