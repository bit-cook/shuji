/**
 * 枢机 · Cardinal Bridge —— OpenClaw 插件入口。
 *
 * 挂 before_agent_reply 钩子（typed hook，需 allowConversationAccess）：
 *   - 消息命中 Cardinal 命令（/ping /list /status /tasks /cost /dispatch /confirm /help）
 *       -> POST 给枢机命令路由，返回 {handled:true, reply:{text}}，不调模型
 *   - 非命令 -> 返回 undefined，消息照常走 OpenClaw AI
 *
 * 安装（本地 link 方式，OpenClaw 2026.3.24+）：
 *   openclaw plugins install --link ./packages/openclaw-cardinal-plugin --force
 *   openclaw plugins enable cardinal-bridge
 * 然后在本机 openclaw.json 里授予会话钩子权限并配置：
 *   { "plugins": { "entries": { "cardinal-bridge": {
 *       "enabled": true,
 *       "hooks": { "allowConversationAccess": true },
 *       "config": { "cardinalBase": "http://127.0.0.1:8080", "cardinalToken": "可选" }
 *   } } } }
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { extractCommand } from './commands';
import { askCardinal, CardinalError } from './cardinal-client';

interface PluginConfig {
  cardinalBase?: string;
  cardinalToken?: string;
  timeoutMs?: number;
}

export default definePluginEntry({
  id: 'cardinal-bridge',
  name: 'Cardinal Bridge',
  description: '把 /ping /list 等 Cardinal 命令从聊天通道转给枢机控制面，不调模型',
  register(api) {
    const cfg = (api.pluginConfig || {}) as PluginConfig;

    api.on(
      'before_agent_reply',
      async (event: { cleanedBody?: string }, ctx: { senderId?: string | number }) => {
        const cmd = extractCommand(event.cleanedBody || '');
        if (!cmd) return undefined; // 非命令：走正常 AI 路径
        try {
          const reply = await askCardinal(
            {
              base: cfg.cardinalBase || '',
              token: cfg.cardinalToken,
              timeoutMs: cfg.timeoutMs,
            },
            { from: String(ctx.senderId ?? ''), text: cmd },
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
