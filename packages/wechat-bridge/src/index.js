'use strict';
const { createRouter } = require('./core');
const { createMcClient } = require('./mc-client');
const { createAudit } = require('./audit');
const { createConfirmStore } = require('./confirm');
const { createHttpAdapter } = require('./adapters/http');
const { createWecomAdapter, createWecomNotifier, listen } = require('./adapters/wecom');
const { createTelegramAdapter } = require('./adapters/telegram');
const { createRateLimiter } = require('./ratelimit');
const { createStats } = require('./stats');
const { createLogger } = require('./log');

const ADAPTERS = ['http', 'telegram', 'wecom'];

function splitList(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function num(v, dflt) {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 纯校验（不建服务）：供 CLI --check 与启动前自检使用。
 * 返回 { ok, errors[], warnings[], config }。
 */
function validateConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const adapter = String(env.ADAPTER || 'http').toLowerCase();
  const allowFrom = [...splitList(env.WECHAT_ALLOW_FROM), ...splitList(env.TELEGRAM_ALLOW_FROM)];

  if (allowFrom.length === 0) {
    errors.push('WECHAT_ALLOW_FROM / TELEGRAM_ALLOW_FROM 至少配置一个（命令入口白名单，红线）');
  }
  if (!env.MC_BASE) errors.push('MC_BASE 未配置（管理面地址）');
  if (!env.MC_API_KEY) errors.push('MC_API_KEY 未配置（管理面 API Key）');
  if (!ADAPTERS.includes(adapter)) {
    errors.push(`ADAPTER 只能是 ${ADAPTERS.join(' / ')}，当前为 ${env.ADAPTER}`);
  }
  if (adapter === 'telegram' && !env.TELEGRAM_BOT_TOKEN) {
    errors.push('ADAPTER=telegram 需要 TELEGRAM_BOT_TOKEN');
  }
  if (adapter === 'wecom') {
    for (const k of ['WECOM_TOKEN', 'WECOM_ENCODING_AES_KEY', 'WECOM_CORP_ID']) {
      if (!env[k]) errors.push(`ADAPTER=wecom 需要 ${k}`);
    }
  }
  if (adapter !== 'telegram') {
    const host = env.HOST || '127.0.0.1';
    const port = Number(env.PORT || 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`PORT 非法：${env.PORT}`);
    if (!env.BRIDGE_TOKEN) {
      warnings.push('未配置 BRIDGE_TOKEN：/message 与 /openclaw 端点无鉴权（仅靠回环/内网绑定保护）');
    }
    if (!env.AUDIT_LOG) {
      warnings.push('未配置 AUDIT_LOG：将写入当前目录 audit.jsonl（红线：全量审计默认开启）');
    }
  }
  return { ok: errors.length === 0, errors, warnings, adapter, allowFrom };
}

/** 红线：默认禁止把 HTTP 适配器绑到公网地址（0.0.0.0 / ::），需显式 ALLOW_PUBLIC_BIND=1  opted-in。 */
function guardPublicBind(host, adapter, env = process.env) {
  if (adapter === 'telegram') return; // 长轮询出站，无监听面
  const h = String(host || '').toLowerCase();
  const wildcard = h === '0.0.0.0' || h === '::' || h === '[::]' || h === '';
  if (!wildcard) return;
  if (String(env.ALLOW_PUBLIC_BIND || '') === '1') {
    process.stderr.write('[warn] 已按 ALLOW_PUBLIC_BIND=1 绑定通配地址——确认该网卡不是公网\n');
    return;
  }
  throw new Error(
    `拒绝绑定 ${host}：控制面与网关端口不得暴露公网（红线）。\n` +
    '  跨主机请绑 Tailscale 网卡地址（hostname -I 查 100.x.x.x），或设 HOST=127.0.0.1；\n' +
    '  确需通配绑定时显式设置 ALLOW_PUBLIC_BIND=1。');
}

/**
 * 从环境变量装配整桥。返回 { router, server?, stats?, logger } 或 telegram 时的 { router, polling }。
 */
function createBridgeFromEnv(env = process.env) {
  // 命令入口白名单（红线）：微信 ID 与 Telegram 用户 ID 合并，至少配置一个。
  const allowFrom = [...splitList(env.WECHAT_ALLOW_FROM), ...splitList(env.TELEGRAM_ALLOW_FROM)];
  if (allowFrom.length === 0) {
    throw new Error('WECHAT_ALLOW_FROM / TELEGRAM_ALLOW_FROM 至少配置一个（命令入口白名单，红线）');
  }

  const logger = createLogger({ base: { app: 'wechat-bridge' } });
  const mc = createMcClient({
    base: env.MC_BASE,
    apiKey: env.MC_API_KEY,
    timeoutMs: num(env.MC_TIMEOUT_MS, 10000),
    attempts: num(env.MC_RETRY, 2),
    logger,
  });
  // 审计默认开启（红线）；显式 AUDIT_LOG=none 才关闭
  const audit = createAudit({
    file: env.AUDIT_LOG || 'audit.jsonl',
    maxBytes: num(env.AUDIT_MAX_BYTES, 10 * 1024 * 1024),
    keep: num(env.AUDIT_KEEP, 3),
  });
  const confirmStore = createConfirmStore({ ttlMs: num(env.CONFIRM_TTL_MS, 60000) });
  const stats = createStats();
  const rateLimiter = createRateLimiter({
    perMinute: num(env.RATE_LIMIT_PER_MIN, 60),
    burst: num(env.RATE_LIMIT_BURST, 20),
  });
  const router = createRouter({ mc, allowFrom, audit, confirmStore, rateLimiter, stats, logger });

  const adapter = String(env.ADAPTER || 'http').toLowerCase();
  const port = Number(env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';

  if (adapter === 'telegram') {
    const telegram = createTelegramAdapter({
      router,
      token: env.TELEGRAM_BOT_TOKEN,
      apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
      pollTimeout: num(env.TELEGRAM_POLL_TIMEOUT, 30),
      drainBacklog: env.TELEGRAM_DRAIN_BACKLOG !== '0',
      validateToken: env.TELEGRAM_VALIDATE_TOKEN === '1',
      logger,
    });
    const polling = telegram.start();
    return { router, telegram, polling, stats, logger };
  }

  guardPublicBind(host, adapter, env);

  if (adapter === 'wecom') {
    const wecom = createWecomAdapter({
      token: env.WECOM_TOKEN,
      encodingAesKey: env.WECOM_ENCODING_AES_KEY,
      corpId: env.WECOM_CORP_ID,
      router,
      path: env.WECOM_CALLBACK_PATH || '/callback',
      timestampWindowSec: num(env.WECOM_TIMESTAMP_WINDOW_SEC, 300),
      logger,
    });
    const notifier = createWecomNotifier({
      corpId: env.WECOM_CORP_ID, agentId: env.WECOM_AGENT_ID, secret: env.WECOM_SECRET,
    });
    const server = listen({ handler: wecom.handler, port, host });
    return { router, server, wecom, notifier, stats, logger };
  }

  // http：OpenClaw 插件（/openclaw）与人工排查（/message）共用
  const http = createHttpAdapter({
    router,
    paths: splitList(env.HTTP_PATHS).length ? splitList(env.HTTP_PATHS) : ['/message', '/openclaw'],
    token: env.BRIDGE_TOKEN || undefined,
    stats,
    logger,
  });
  const server = listen({ handler: http.handler, port, host });
  return { router, server, http, stats, logger };
}

module.exports = {
  createRouter, createMcClient, createAudit, createConfirmStore,
  createHttpAdapter, createWecomAdapter, createWecomNotifier, createTelegramAdapter,
  createBridgeFromEnv, listen, validateConfig, ADAPTERS,
};
