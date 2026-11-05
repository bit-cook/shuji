# 枢机 · Mission-Control — 控制面

Agent 注册 / 心跳 / 任务下发 / 成本计量的唯一持久真相。Node 仅标准库，
存储用 `node:sqlite`（**Node 22.5+，推荐 24**——24 起无需实验 flag）。

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 免 | 探针，回 `{status:'ok'}` |
| GET | `/statsz` | 免 | 计数快照（无敏感字段） |
| GET | `/api/agents` | Bearer | 全部 Agent |
| GET | `/api/agents/<id>` | Bearer | 单个 Agent，未知 id → 404 |
| GET | `/api/agents/<id>/tasks` | Bearer | 该 Agent 的任务（新→旧），未知 id → 404 |
| GET | `/api/costs/summary` | Bearer | Token / 成本汇总 |
| POST | `/api/agents/heartbeat` | Bearer | generic 协议注册/更新 |
| POST | `/api/tasks` | Bearer | 下发任务，未注册 Agent → 404 |
| POST | `/api/tasks/<id>/claim` | Bearer | 工人取任务（pending → running） |
| POST | `/api/tasks/<id>/complete` | Bearer | 工人回报（→ done/failed/cancelled） |

`<id>` 需 URL 编码（`encodeURIComponent`）。

## 心跳报文（generic 协议）

```json
{
  "framework": "generic",
  "action": "heartbeat",
  "payload": {
    "agentId": "hermes-node-b",
    "status": "online",
    "reportedAt": 1793876108,
    "detail": { "sessions": 3, "usage": { "tokens": 1234, "costUsd": 0.42 } }
  }
}
```

`reportedAt` 是**秒**（`int(time.time())`）——控制面会换算成毫秒再和
`Date.now()` 比较。混用两个单位会让「心跳超时纠偏」把刚上报的 Agent 立刻判成离线。

`detail.usage` 可选，会累计进该 Agent 的成本；任务的 `tokens` / `costUsd`
在 complete 时计入。`/api/costs/summary` 把两者合并按 Agent 分组。

## 两条读路径纠偏

1. **心跳超时报离线**：`MC_STALE_SEC`（默认 900）内没有新心跳的 Agent，
   `/list` 一律显示 `offline`，并附 `reportedStatus`（它自己最后报的状态）与 `stale: true`。
   否则面板会把早已死掉的 Agent 显示成最后一份心跳自称的 online。
2. **任务标题超长截断**：`MC_MAX_TASK_TITLE`（默认 4000）以上截断，
   响应回带 `titleTruncated: true`——比回 413 让用户只看到「管理面返回 413」有用。

## 任务生命周期

```
POST /api/tasks            → pending
POST /api/tasks/<id>/claim → running   （重复 claim 回 409 not_pending）
POST /api/tasks/<id>/complete → done | failed | cancelled
```

重复 claim / 对已完成任务 complete 都返回 409 + 当前状态，不静默成功。

## 运行

```bash
MC_API_KEY=$(openssl rand -hex 24) \
MC_DB=/var/lib/mission-control/mission-control.db \
node packages/mission-control/src/cli.js

node packages/mission-control/src/cli.js --check    # 只校验配置与目录可写
```

红线：

- `MC_API_KEY` 必填——控制面是全局下令入口，无鉴权等于把全部 Agent 交给同主机任何账号
- 默认只绑 `127.0.0.1`；绑 `0.0.0.0` / `::` 需显式 `ALLOW_PUBLIC_BIND=1`
- 审计默认开启（`audit.jsonl`，0600 + 10MB 轮转 + logrotate 兜底），
  **只记元数据**（方法 / 路径 / 状态 / 耗时 / IP），不记请求体——任务标题可能含机密
- 数据库目录 750，服务以专用非 root 账号运行

## 测试

```bash
npm run test:mc     # 92 项 node:test
```

覆盖：报文归一化（秒/毫秒、多字段名、usage 累计）、心跳超时纠偏、
任务状态机与并发重复领取、每 Agent 任务裁剪、成本合并、持久化（重开库）、
路由匹配、Bearer 鉴权、413 / 429 / 裸 TCP 断链韧性、审计不含密钥。
