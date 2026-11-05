'use strict';
const { createRouter } = require('./core');
const { createMcClient } = require('./mc-client');
const { createAudit } = require('./audit');
const { createConfirmStore } = require('./confirm');
const { createHttpAdapter } = require('./adapters/http');
const { createWecomAdapter, createWecomNotifier, listen } = require('./adapters/wecom');
const { createTelegramAdapter } = require('./adapters/telegram');
const { createWeixinAdapter, readState } = require('./adapters/weixin');
const { runWeixinLogin } = require('./ilink-login');
const { createRateLimiter } = require('./ratelimit');
const { createStats } = require('./stats');
const { createLogger } = require('./log');
const fs = require('node:fs');
const path = require('node:path');

const ADAPTERS = ['http', 'telegram', 'wecom', 'weixin'];

/** 配置错误：与 mission-control 的 ConfigError 同构，便于两层用同一套处理。 */
class ConfigError extends Error {
  constructor(errors) {
    super(Array.isArray(errors) ? errors.join('\n  - ') : String(errors));
    this.name = 'ConfigError';
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
  }
}

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
  const wechatFrom = splitList(env.WECHAT_ALLOW_FROM);
  const telegramFrom = splitList(env.TELEGRAM_ALLOW_FROM);
  const allowFrom = [...wechatFrom, ...telegramFrom];

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
  if (adapter === 'telegram') {
    // 这两个开关只认精确值（'1' / '0'）。拼成 yes/true/on 不会报错，
    // 而是静默按默认值走——令牌错了不校验、积压消息该丢不丢，都属于
    // 「配了却没生效」。所以在这里就把拼错挡下。
    for (const [k, allowed] of [
      ['TELEGRAM_VALIDATE_TOKEN', ['0', '1']],
      ['TELEGRAM_DRAIN_BACKLOG', ['0', '1']],
    ]) {
      const v = env[k];
      if (v !== undefined && String(v) !== '' && !allowed.includes(String(v))) {
        errors.push(`${k} 只能是 ${allowed.join(' 或 ')}，当前为 ${v}（拼错会被静默当成默认值）`);
      }
    }
  }
  if (adapter === 'wecom') {
    for (const k of ['WECOM_TOKEN', 'WECOM_ENCODING_AES_KEY', 'WECOM_CORP_ID']) {
      if (!env[k]) errors.push(`ADAPTER=wecom 需要 ${k}`);
    }
  }
  if (adapter === 'weixin') {
    // 令牌可以来自环境变量，也可以来自扫码登录后持久化的状态文件。两处都没有
    // 说明这个进程还没登录过——它会启动成功然后一条消息也收不到，所以启动时就挡下。
    const stateFile = env.WECHAT_STATE_FILE || '';
    const hasState = stateFile && readState(stateFile);
    if (!env.WECHAT_BOT_TOKEN && !hasState) {
      errors.push(
        'ADAPTER=weixin 但没有可用令牌：既没有 WECHAT_BOT_TOKEN，也没有扫码登录过的状态文件。\n' +
        '  先在有终端的机器上执行：wechat-bridge --adapter weixin --login（扫码后令牌写入 WECHAT_STATE_FILE）');
    }
    if (stateFile && !path.isAbsolute(stateFile)) {
      errors.push('WECHAT_STATE_FILE 必须是绝对路径（令牌是机密，不接受相对路径随工作目录漂移）');
    }
  }
  // 一个进程只跑一个适配器，白名单取并集不会越权（微信消息到不了 telegram 适配器）。
  // 但「当前适配器自己的白名单是空的」意味着这个进程永远服务不了任何真实用户——
  // 没有一种正当配置长这样，所以按错误处理：起来也是白起来，还不如启动失败。
  if (adapter === 'telegram' && telegramFrom.length === 0) {
    errors.push('ADAPTER=telegram 但 TELEGRAM_ALLOW_FROM 为空：Telegram 消息只会到达这个适配器，白名单为空则所有用户都会被拒（服务能启动，但永远服务不了任何人）');
  }
  if (adapter !== 'telegram' && wechatFrom.length === 0) {
    errors.push(`ADAPTER=${adapter} 但 WECHAT_ALLOW_FROM 为空：${adapter === 'wecom' ? '企业微信' : adapter === 'weixin' ? '微信' : 'HTTP/OpenClaw'} 消息只会到达这个适配器，白名单为空则所有用户都会被拒（服务能启动，但永远服务不了任何人）`);
  }
  if (adapter !== 'telegram') {
    const host = env.HOST || '127.0.0.1';
    const port = Number(env.PORT || 8080);
    // PORT=0 = 让内核挑空闲端口（测试与临时排障用）。它会在启动日志里打出真实端口，
    // 所以不算是「配了却没生效」；但生产环境写 0 几乎一定是笔误，给警告。
    if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push(`PORT 非法：${env.PORT}`);
    if (port === 0) warnings.push('PORT=0：由内核分配随机端口，仅适合测试/临时排障；生产环境请写固定端口');
    if (!env.BRIDGE_TOKEN) {
      warnings.push('未配置 BRIDGE_TOKEN：/message 与 /openclaw 端点无鉴权（仅靠回环/内网绑定保护）');
    }
  }
  // 审计与适配器无关：telegram 长轮询同样全量留痕，漏配 AUDIT_LOG 时它会静默写进
  // 当前工作目录（用户级单元的 cwd 就是 $HOME）——所以这条告警对所有适配器都生效。
  if (!env.AUDIT_LOG) {
    warnings.push('未配置 AUDIT_LOG：将写入当前目录 audit.jsonl（红线：全量审计默认开启）');
  }
  return { ok: errors.length === 0, errors, warnings, adapter, allowFrom, wechatFrom, telegramFrom };
}

/** 红线：默认禁止把 HTTP 适配器绑到公网地址（0.0.0.0 / ::），需显式 ALLOW_PUBLIC_BIND=1  opted-in。 */
function guardPublicBind(host, adapter, env = process.env) {
  // 长轮询出站（telegram / weixin），没有监听面可言
  if (adapter === 'telegram' || adapter === 'weixin') return;
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
 *
 * 启动前先跑一遍 validateConfig：光有 --check 不够——systemd / compose 起服务时没人会
 * 手动加那个参数，于是「配了却没生效」的错（如 telegram 适配器只配了微信白名单）
 * 会以一个正常启动、然后拒绝每一个真实用户的形式存在，日志里一行提示都没有。
 * errors 直接抛（启动失败比静默拒绝好），warnings 打进日志。
 */
function createBridgeFromEnv(env = process.env) {
  const pre = validateConfig(env);
  const logger = createLogger({ base: { app: 'wechat-bridge' } });
  for (const w of pre.warnings) logger.warn(w);
  if (!pre.ok) {
    const err = new ConfigError(pre.errors);
    err.warnings = pre.warnings;
    throw err;
  }

  // 命令入口白名单（红线）：微信 ID 与 Telegram 用户 ID 合并，至少配置一个。
  const allowFrom = [...splitList(env.WECHAT_ALLOW_FROM), ...splitList(env.TELEGRAM_ALLOW_FROM)];
  if (allowFrom.length === 0) {
    throw new ConfigError(['WECHAT_ALLOW_FROM / TELEGRAM_ALLOW_FROM 至少配置一个（命令入口白名单，红线）']);
  }

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

  if (adapter === 'telegram' || adapter === 'weixin') {
    // 长轮询类适配器共用的启动形状：都没有监听端口，bridge 返回 polling 句柄
    // 供 cli.js 的 SIGTERM 处理器调用 stop()。
    const polling = adapter === 'telegram'
      ? createTelegramAdapter({
        router,
        token: env.TELEGRAM_BOT_TOKEN,
        apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
        pollTimeout: num(env.TELEGRAM_POLL_TIMEOUT, 30),
        drainBacklog: env.TELEGRAM_DRAIN_BACKLOG !== '0',
        validateToken: env.TELEGRAM_VALIDATE_TOKEN === '1',
        logger,
      }).start()
      : createWeixinAdapter({
        router,
        token: env.WECHAT_BOT_TOKEN || undefined,
        stateFile: env.WECHAT_STATE_FILE || undefined,
        apiBase: env.WECHAT_API_BASE || undefined,
        botType: env.WECHAT_BOT_TYPE || undefined,
        logger,
      }).start();
    return {
      router, polling, stats, logger, adapter,
      ...(adapter === 'weixin' ? { weixin: polling } : { telegram: polling }),
    };
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
  createHttpAdapter, createWecomAdapter, createWecomNotifier, createTelegramAdapter, createWeixinAdapter,
  createBridgeFromEnv, listen, validateConfig, ADAPTERS, ConfigError, runWeixinLogin,
};
