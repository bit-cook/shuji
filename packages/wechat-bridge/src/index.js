'use strict';
const { createRouter } = require('./core');
const { createMcClient } = require('./mc-client');
const { createAudit } = require('./audit');
const { createConfirmStore } = require('./confirm');
const { createHttpAdapter } = require('./adapters/http');
const { createWecomAdapter, createWecomNotifier, listen } = require('./adapters/wecom');
const { createTelegramAdapter } = require('./adapters/telegram');

/**
 * 从环境变量装配整桥。返回 { router, server } 或仅 { router }（未指定 adapter 时）。
 */
function createBridgeFromEnv(env = process.env) {
  // 命令入口白名单（红线）：微信 ID 与 Telegram 用户 ID 合并，
  // 至少配置一个；Cardinal 只服务本人。
  const allowFrom = [
    ...String(env.WECHAT_ALLOW_FROM || '').split(','),
    ...String(env.TELEGRAM_ALLOW_FROM || '').split(','),
  ].map((s) => s.trim()).filter(Boolean);
  if (allowFrom.length === 0) {
    throw new Error('WECHAT_ALLOW_FROM / TELEGRAM_ALLOW_FROM 至少配置一个（命令入口白名单，红线）');
  }

  const mc = createMcClient({ base: env.MC_BASE, apiKey: env.MC_API_KEY });
  const audit = createAudit({ file: env.AUDIT_LOG || undefined });
  const confirmStore = createConfirmStore({ ttlMs: Number(env.CONFIRM_TTL_MS || 60000) });
  const router = createRouter({ mc, allowFrom, audit, confirmStore });

  const adapter = (env.ADAPTER || 'http').toLowerCase();
  const port = Number(env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';

  if (adapter === 'telegram') {
    const telegram = createTelegramAdapter({
      router,
      token: env.TELEGRAM_BOT_TOKEN,
      apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
      pollTimeout: Number(env.TELEGRAM_POLL_TIMEOUT || 30),
      drainBacklog: env.TELEGRAM_DRAIN_BACKLOG !== '0',
    });
    const polling = telegram.start();
    return { router, telegram, polling };
  }

  if (adapter === 'wecom') {
    const wecom = createWecomAdapter({
      token: env.WECOM_TOKEN,
      encodingAesKey: env.WECOM_ENCODING_AES_KEY,
      corpId: env.WECOM_CORP_ID,
      router,
      path: env.WECOM_CALLBACK_PATH || '/callback',
    });
    const notifier = createWecomNotifier({
      corpId: env.WECOM_CORP_ID, agentId: env.WECOM_AGENT_ID, secret: env.WECOM_SECRET,
    });
    const server = listen({ handler: wecom.handler, port, host });
    return { router, server, wecom, notifier };
  }

  // http：OpenClaw 插件（/openclaw）与人工排查（/message）共用
  const http = createHttpAdapter({ router, paths: (env.HTTP_PATHS || '/message,/openclaw').split(',') });
  const server = listen({ handler: http.handler, port, host });
  return { router, server, http };
}

module.exports = {
  createRouter, createMcClient, createAudit, createConfirmStore,
  createHttpAdapter, createWecomAdapter, createWecomNotifier, createTelegramAdapter,
  createBridgeFromEnv, listen,
};
