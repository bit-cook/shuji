'use strict';
const { createRouter } = require('./core');
const { createMcClient } = require('./mc-client');
const { createAudit } = require('./audit');
const { createConfirmStore } = require('./confirm');
const { createHttpAdapter } = require('./adapters/http');
const { createWecomAdapter, createWecomNotifier, listen } = require('./adapters/wecom');

/**
 * 从环境变量装配整桥。返回 { router, server } 或仅 { router }（未指定 adapter 时）。
 */
function createBridgeFromEnv(env = process.env) {
  const allowFrom = String(env.WECHAT_ALLOW_FROM || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowFrom.length === 0) throw new Error('WECHAT_ALLOW_FROM 未配置（命令入口白名单，红线）');

  const mc = createMcClient({ base: env.MC_BASE, apiKey: env.MC_API_KEY });
  const audit = createAudit({ file: env.AUDIT_LOG || undefined });
  const confirmStore = createConfirmStore({ ttlMs: Number(env.CONFIRM_TTL_MS || 60000) });
  const router = createRouter({ mc, allowFrom, audit, confirmStore });

  const adapter = (env.ADAPTER || 'http').toLowerCase();
  const port = Number(env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';

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

  const http = createHttpAdapter({ router, path: env.HTTP_PATH || '/message' });
  const server = listen({ handler: http.handler, port, host });
  return { router, server, http };
}

module.exports = {
  createRouter, createMcClient, createAudit, createConfirmStore,
  createHttpAdapter, createWecomAdapter, createWecomNotifier, createBridgeFromEnv, listen,
};
