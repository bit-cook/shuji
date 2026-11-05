# 枢机 · Cardinal Bridge — OpenClaw 插件

把聊天通道（微信 ClawBot/iLink、Telegram、其他）里的 **Cardinal 命令**
确定性地转给枢机控制面执行，**不调模型**；非命令消息照常走 OpenClaw AI。

- 命令：`/ping` `/list` `/status <id>` `/tasks <id>` `/cost` `/dispatch <id> <任务>` `/confirm <token>` `/help`
- 安全：发送者 ID 原样传给枢机命令路由，由枢机的 `WECHAT_ALLOW_FROM` 白名单终审（红线）
- 协议：`POST {cardinalBase}/openclaw` `{"from":"<senderId>","text":"<命令>"}` → `{"reply":"..."}`

## 安装（本地 link 方式）

要求 OpenClaw 2026.3.24+，Node 24：

```bash
# 在 OpenClaw 仓库/安装根目录执行
openclaw plugins install --link /path/to/shuji/packages/openclaw-cardinal-plugin --force
openclaw plugins enable cardinal-bridge
```

在 OpenClaw 配置（openclaw.json）里授予会话钩子权限并指向枢机：

```json
{
  "plugins": {
    "entries": {
      "cardinal-bridge": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "cardinalBase": "http://127.0.0.1:8080",
          "cardinalToken": "可选：与桥共用的 Bearer 令牌"
        }
      }
    }
  }
}
```

hybrid 热加载会应用配置；随后：

```bash
openclaw plugins inspect cardinal-bridge --runtime --json   # 确认 before_agent_reply 已注册
```

微信侧：按 OpenClaw 官方文档装 `@tencent-weixin/openclaw-weixin` 插件并扫码绑定
（微信 ClawBot，iLink 协议，仅私聊）。绑定后给机器人发 `/ping`，应直接收到 `pong · …`。

## 配置项

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `cardinalBase` | 是 | 枢机命令路由地址，如 `http://127.0.0.1:8080` |
| `cardinalToken` | 否 | 调用 `/openclaw` 时的 Bearer 令牌 |
| `timeoutMs` | 否 | 调用超时，默认 10000 |

## 测试

```bash
cd packages/openclaw-cardinal-plugin
npm test          # node --test（命令识别 + 客户端，11 项）
npx tsc --noEmit  # 对着真实 openclaw SDK 的类型检查
```
