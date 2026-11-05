# 枢机 · Cardinal Bridge — OpenClaw 插件

把聊天通道（微信 ClawBot/iLink、Telegram、其他）里的 **Cardinal 命令**
确定性地转给枢机控制面执行，**不调模型**；非命令消息照常走 OpenClaw AI。

- 命令：`/ping` `/list` `/status <id>` `/tasks <id>` `/cost` `/dispatch <id> <任务>` `/confirm <token>` `/help`
- 安全：发送者 ID 传给枢机命令路由，由枢机的 `WECHAT_ALLOW_FROM` / `TELEGRAM_ALLOW_FROM` 白名单终审（红线）
- 协议：`POST {cardinalBase}/openclaw` `{"from":"<senderId>","text":"<命令>"}` → `{"reply":"..."}`

## 链路（微信主线）

```
微信 → ClawBot（@tencent-weixin/openclaw-weixin，iLink）→ OpenClaw Gateway
     → cardinal-bridge 插件（本插件）→ POST 枢机桥 /openclaw → Mission-Control
```

插件挂两个钩子：

| 钩子 | 作用 |
| --- | --- |
| `message_received`（观察） | 按 sessionKey 记下发送者 ID——`before_agent_reply` 的 ctx 不带 senderId，而白名单终审必须要它 |
| `before_agent_reply`（Claim） | 消息命中命令就不调模型，直连枢机；非命令返回 undefined，照常走 AI |

发送者解析顺序：`message_received` 缓存 → prepared prompt 通道前缀 → 未知（桥侧拒绝，fail-closed）。
缓存按 TTL（10 分钟）与容量（200 会话）自动收缩，不随会话数无限增长。

命令识别规则是「**某一行以 `/命令词` 开头**」：普通对话里提到命令
（「看看 /list 怎么用」）不会劫持消息，用户照样能向 AI 提问。

## 安装（本地 link 方式）

要求 OpenClaw 2026.3.24+，Node 24：

```bash
# 在 OpenClaw 仓库/安装根目录执行
openclaw plugins install --link /path/to/shuji/packages/openclaw-cardinal-plugin --force
openclaw plugins enable cardinal-bridge
```

在 OpenClaw 配置（openclaw.json）里指向枢机：

```json
{
  "plugins": {
    "entries": {
      "cardinal-bridge": {
        "enabled": true,
        "config": {
          "cardinalBase": "http://127.0.0.1:8080",
          "cardinalToken": "与桥的 BRIDGE_TOKEN 同一个值（强烈建议配置）"
        }
      }
    }
  }
}
```

> `cardinalToken` 要与枢机桥的 `BRIDGE_TOKEN` 一致：桥配置了该值就会对
> `/openclaw` 强制 Bearer 鉴权，不配令牌的请求一律 401。

hybrid 热加载会应用配置；随后：

```bash
openclaw plugins inspect cardinal-bridge --runtime --json   # 确认两个钩子已注册
```

微信侧：按 OpenClaw 官方文档装 `@tencent-weixin/openclaw-weixin` 插件并扫码绑定
（微信 ClawBot，iLink 协议，仅私聊）。绑定后给机器人发 `/ping`，应直接收到 `pong · …`。
Telegram 侧无需本插件——枢机桥以 `ADAPTER=telegram` 长轮询直连即可。

## 配置项

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `cardinalBase` | 是 | 枢机命令路由地址，如 `http://127.0.0.1:8080` |
| `cardinalToken` | 否 | 调用 `/openclaw` 时的 Bearer 令牌（桥侧配了 `BRIDGE_TOKEN` 就必填） |
| `timeoutMs` | 否 | 调用超时，默认 10000 |

## 测试

```bash
cd packages/openclaw-cardinal-plugin
npm test          # node --test（命令识别 / 发送者缓存 / 客户端）
npx tsc --noEmit  # 对着真实 openclaw SDK 的类型检查
```
