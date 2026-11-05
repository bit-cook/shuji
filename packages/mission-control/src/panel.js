'use strict';
/**
 * 枢机 · 网页可视化面板。
 *
 * 挂在控制面同一个 HTTP 服务上，因此自动继承已有的三件事：默认只绑 127.0.0.1
 * （绑通配地址要显式 ALLOW_PUBLIC_BIND=1）、每 IP 令牌桶限流、全量审计。
 * 面板自己不新开端口、不新开监听面。
 *
 * 鉴权为什么不复用 Bearer：浏览器不方便每次请求都带头，所以用一次性交换——
 * POST /panel/login 拿 MC_API_KEY 换一个 HttpOnly 的会话 Cookie。Cookie 里存的是
 * `<会话号>.<过期时间>.<HMAC>`，HMAC 用 MC_API_KEY 对前两段签名：
 *   - 改Cookie任意一段都验不过（签名对不上）
 *   - 偷走Cookie也没法续期（过期时间在签名里，服务端时钟到了就不认）
 *   - 不知道 MC_API_KEY 就伪造不出合法Cookie
 * 全程 constant-time 比较，登录失败按 IP 限流。
 *
 * 面板是**只读**的：只暴露 GET 快照，不提供下发任务、领取、回报的入口。
 * 写操作一律回到命令入口（微信 / Telegram）走危险命令二次确认——那里有 60 秒
 * 一次性令牌、只允许发起人确认、全量审计。面板不引入第二条写路径，也就不引入
 * CSRF 面：SameSite=Strict + 无状态变更，跨站表单打过来也无事可做。
 */
const crypto = require('node:crypto');
const { createRateLimiter } = require('./ratelimit');
const { PAGE_HTML } = require('./panel-page');

const PANEL_PATH = '/panel';
const COOKIE_NAME = 'cardinal_panel';
/** 会话有效期：12 小时。够用一整个工作时段，又不至于一份Cookie永久有效。 */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 登录尝试限流：每 IP 每分钟 5 次，没有突发额度。 */
const LOGIN_PER_MIN = 5;

function parseCookies(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sign(apiKey, sid, exp) {
  return crypto.createHmac('sha256', String(apiKey)).update(`${sid}.${exp}`).digest('base64url');
}

function createPanel({
  store,
  config,
  logger = console,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  sessionTtlMs,
  loginLimiter,
} = {}) {
  if (!store) throw new Error('createPanel 需要 store');
  const log = logger.error ? logger : { debug() {}, info() {}, warn() {}, error() {} };
  const apiKey = (config && config.apiKey) ? String(config.apiKey) : '';
  const enabled = !config || config.panel !== false;
  const ttl = Math.max(60000, Number(sessionTtlMs || (config && config.panelSessionTtlMs) || DEFAULT_SESSION_TTL_MS));
  const limiter = loginLimiter || createRateLimiter({ perMinute: LOGIN_PER_MIN, burst: LOGIN_PER_MIN, now });

  function cookieHeader(sid, exp, ttlSec) {
    const attrs = [
      `${COOKIE_NAME}=${sid}.${exp}.${sign(apiKey, sid, exp)}`,
      'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${ttlSec}`,
    ];
    return attrs.join('; ');
  }

  function readSession(req) {
    const cookies = parseCookies(req);
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [sid, expRaw, mac] = parts;
    if (!/^[0-9a-f]{32}$/.test(sid)) return null;
    if (!/^[0-9]+$/.test(expRaw)) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= now()) return null;
    if (!safeEqual(mac, sign(apiKey, sid, expRaw))) return null;
    return { sid, exp };
  }

  /** 面板自己处理的路由。返回 null 表示不归面板管。 */
  function match(method, pathname) {
    if (!enabled) return null;
    if (pathname === PANEL_PATH || pathname === `${PANEL_PATH}/`) {
      return method === 'GET' ? { route: 'GET /panel', fn: servePage } : null;
    }
    if (pathname === `${PANEL_PATH}/login`) return method === 'POST' ? { route: 'POST /panel/login', fn: login } : null;
    if (pathname === `${PANEL_PATH}/logout`) return method === 'POST' ? { route: 'POST /panel/logout', fn: logout } : null;
    if (pathname === `${PANEL_PATH}/api/session`) return method === 'GET' ? { route: 'GET /panel/api/session', fn: sessionInfo } : null;
    if (pathname === `${PANEL_PATH}/api/snapshot`) return method === 'GET' ? { route: 'GET /panel/api/snapshot', fn: snapshot } : null;
    return null;
  }

  // 所有面板路由统一签名 (body, req, ip)：server.js 按同一个形状调用，
  // 避免「哪个函数第一个参数是 req」这种因人而异的暗坑。
  function servePage() {
    return { status: 200, body: PAGE_HTML, headers: { 'Content-Type': 'text/html; charset=utf-8' } };
  }

  function sessionInfo(_body, req) {
    return { status: 200, body: { authenticated: Boolean(readSession(req)) } };
  }

  function login(body, req, ip) {
    if (!apiKey) return { status: 503, body: { message: '面板不可用：MC_API_KEY 未配置' } };
    const gate = limiter.check(ip || 'unknown');
    if (!gate.ok) {
      return { status: 429, body: { message: '登录尝试过于频繁', retryAfterMs: gate.retryAfterMs } };
    }
    const supplied = body && typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!supplied || !safeEqual(supplied, apiKey)) {
      log.warn('panel login rejected', { ip });
      return { status: 401, body: { message: 'API Key 不正确' } };
    }
    const sid = crypto.randomBytes(16).toString('hex');
    const exp = now() + ttl;
    return {
      status: 200,
      body: { ok: true, expiresAt: exp },
      headers: { 'Set-Cookie': cookieHeader(sid, exp, Math.floor(ttl / 1000)) },
    };
  }

  function logout() {
    return {
      status: 200,
      body: { ok: true },
      // Max-Age=0 让浏览器立刻丢掉这个 Cookie
      headers: { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` },
    };
  }

  function snapshot(_body, req) {
    if (!readSession(req)) return { status: 401, body: { message: '未登录或会话已过期' } };
    const agents = store.listAgents();
    const costs = store.costSummary();
    // 只回渲染需要的字段：Agent 心跳详情里可能带命令原文，不该进浏览器。
    return {
      status: 200,
      body: {
        generatedAt: nowIso(),
        staleSec: (config && config.staleSec) || 0,
        totals: {
          agents: costs.agentCount,
          // 在线的判定与表格一致：纠偏后仍自称 online 才算。只看 !stale 的话，
          // 主动上报 offline 的 Agent 会被数进「在线」，KPI 与明细表互相矛盾
          online: agents.filter((a) => !a.stale && a.status === 'online').length,
          tokens: costs.totalTokens,
          costUsd: costs.totalCostUsd,
          tasks: costs.taskCount,
          tasksByStatus: costs.tasksByStatus,
        },
        agents: agents.map((a) => ({
          agentId: a.agentId,
          status: a.status,
          stale: Boolean(a.stale),
          model: a.model || null,
          framework: a.framework || null,
          source: a.source || null,
          lastSeenAt: a.lastSeenAt || null,
          tasks: (costs.byAgent[a.agentId] || {}).tasks || 0,
          tokens: (costs.byAgent[a.agentId] || {}).tokens || 0,
        })),
        byAgent: Object.fromEntries(
          Object.entries(costs.byAgent).map(([id, v]) => [id, {
            tokens: v.tokens, costUsd: v.costUsd, tasks: v.tasks,
            done: v.done, pending: v.pending, running: v.running, failed: v.failed,
          }]),
        ),
      },
    };
  }

  return { match, readSession, PANEL_PATH };
}

module.exports = { createPanel, PANEL_PATH, COOKIE_NAME, DEFAULT_SESSION_TTL_MS, parseCookies, sign };
