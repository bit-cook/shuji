/**
 * 枢机 · Cardinal Bridge —— OpenClaw 插件入口。
 *
 * 挂两个钩子：
 *   1. `message_received`（观察）：按 sessionKey 记下发送者 ID——
 *      reply 钩子的 ctx 不带 senderId，而枢机白名单终审必须要它。
 *   2. `before_agent_reply`（Claim）：消息命中 Cardinal 命令
 *      （/ping /list /status /tasks /cost /dispatch /confirm /help）
 *      → POST 给枢机命令路由，返回 {handled:true, reply:{text}}，不调模型；
 *      非命令 → 返回 undefined，消息照常走 OpenClaw AI。
 *
 * 身份解析顺序：sessionKey 缓存 → prepared prompt 前缀 → 未知（桥侧拒绝，fail-closed）。
 *
 * 安装（本地 link 方式，OpenClaw 2026.3.24+）：
 *   openclaw plugins install --link ./packages/openclaw-cardinal-plugin --force
 *   openclaw plugins enable cardinal-bridge
 * 然后在本机 openclaw.json 里配置：
 *   { "plugins": { "entries": { "cardinal-bridge": {
 *       "enabled": true,
 *       "config": { "cardinalBase": "http://127.0.0.1:8080", "cardinalToken": "可选" }
 *   } } } }
 */
import { definePluginEntry, type PluginHookMessageReceivedEvent } from 'openclaw/plugin-sdk/plugin-entry';
import { extractCommand } from './commands';
import { askCardinal, CardinalError } from './cardinal-client';
import { createSenderCache, resolveSender } from './sender-cache';

interface PluginConfig {
  cardinalBase?: string;
  cardinalToken?: string;
  timeoutMs?: number;
}

/** reply 钩子 ctx 里我们用到的字段（宿主可能还有更多） */
interface ReplyCtx {
  sessionKey?: string;
  heartbeatEventQueueSessionKey?: string;
}

/** message_received 钩子 ctx 里我们用到的字段 */
interface MessageCtx {
  sessionKey?: string;
}

export default definePluginEntry({
  id: 'cardinal-bridge',
  name: 'Cardinal Bridge',
  description: '把 /ping /list 等 Cardinal 命令从聊天通道转给枢机控制面，不调模型',
  register(api) {
    const cfg = (api.pluginConfig || {}) as PluginConfig;
    const senders = createSenderCache();

    // 1) 观察入站消息：记录发送者身份（供 reply 钩子取用）
    api.on(
      'message_received',
      (event: PluginHookMessageReceivedEvent, ctx: MessageCtx) => {
        const key = ctx.sessionKey || event.sessionKey;
        const senderId = event.senderId || event.from;
        if (key && senderId) {
          senders.set(key, { senderId: String(senderId), from: event.from, at: Date.now() });
        }
      },
    );

    // 2) 拦命令：命中就不调模型，直连枢机
    api.on(
      'before_agent_reply',
      async (event: { cleanedBody?: string }, ctx: ReplyCtx) => {
        const body = event.cleanedBody || '';
        const cmd = extractCommand(body);
        if (!cmd) return undefined; // 非命令：走正常 AI 路径

        const key = ctx.sessionKey || ctx.heartbeatEventQueueSessionKey;
        const cached = (key && senders.get(key)) || null;
        const from = resolveSender(cached, body);

        try {
          const reply = await askCardinal(
            {
              base: cfg.cardinalBase || '',
              token: cfg.cardinalToken,
              timeoutMs: cfg.timeoutMs,
            },
            { from, text: cmd },
          );
          return { handled: true as const, reply: { text: reply } };
        } catch (e) {
          const msg = e instanceof CardinalError ? e.message : String(e);
          return { handled: true as const, reply: { text: '枢机响应失败：' + msg } };
        }
      },
      { eligibleTriggers: ['user'] },
    );
  },
});
