'use strict';
/**
 * 控制面 HTTP 服务：命令路由与心跳 Sidecar 的唯一后端。
 *
 * 端点（与 wechat-bridge / hermes-sidecar 的客户端严格对齐）：
 *   GET  /healthz                探针（免鉴权，只回 ok）
 *   GET  /statsz                 计数快照（免鉴权，无敏感字段）
 *   GET  /api/agents             全部 Agent（读路径纠偏：心跳超时报 offline）
 *   GET  /api/agents/<id>        单个 Agent（未知 id → 404）
 *   GET  /api/agents/<id>/tasks  该 Agent 的任务（未知 id → 404）
 *   GET  /api/costs/summary      Token / 成本汇总
 *   POST /api/agents/heartbeat   generic 协议注册/更新（Sidecar 用）
 *   POST /api/tasks              下发任务（bridge 的 /dispatch 用）
 *   POST /api/tasks/<id>/claim   工人取任务
 *   POST /api/tasks/<id>/complete 工人回报结果
 *
 * 红线落地：
 *   - 全部 /api/* 需 Bearer <MC_API_KEY>（constant-time 比较），否则 401 并留痕
 *   - 审计默认开启，只记元数据（方法/路径/状态/耗时/IP），不记请求体——任务标题可能含机密
 *   - 每客户端 IP 令牌桶限流，防重试风暴把库打满
 *   - 请求体上限（超限先回 413 再断链，不让客户端只看到连接重置）
 *   - 未捕获的 req/res error 不会打崩进程
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { createAudit } = require('./audit');
const { createStats } = require('./stats');
const { createRateLimiter } = require('./ratelimit');
const { createLogger, createNoopLogger } = require('./log');

const MAX_PATH = 512;

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    });
    res.end(text);
  } catch { /* 客户端已断开：写失败无所谓 */ }
}

/**
 * 超大请求体：先写 413 再靠 Connection: close 让 Node 收尾关闭。
 * 不能立刻 req.destroy()——那样响应还没发出，客户端只看到连接重置。
 */
function rejectTooLarge(req, res) {
  if (res.writableEnded) return;
  try {
    req.pause();
    res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end('{"message":"payload too large"}');
  } catch { /* 客户端已断开 */ }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 极简路由匹配：'/api/agents/:id/tasks' → { params:{id} } */
function matchRoute(pattern, pathname) {
  const pp = pattern.split('/');
  const xp = pathname.split('/');
  if (pp.length !== xp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) {
      let v = xp[i];
      try { v = decodeURIComponent(v); } catch { return null; }
      if (!v) return null;
      params[pp[i].slice(1)] = v;
    } else if (pp[i] !== xp[i]) {
      return null;
    }
  }
  return { params };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        aborted = true;
        reject(Object.assign(new Error('payload too large'), { code: 'ETOOLARGE', size }));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'EBADJSON' }));
      }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

function createControlServer({
  config,
  store,
  logger = createNoopLogger(),
  audit,
  stats,
  rateLimiter,
  panel,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  httpImpl = http,
} = {}) {
  if (!store) throw new Error('createControlServer 需要 store');
  const log = logger.child ? logger.child({ mod: 'http' }) : createNoopLogger();
  const recorder = audit || createAudit({ file: 'none' });
  const counter = stats || createStats({ now });
  const limiter = rateLimiter || createRateLimiter({ perMinute: 0 });
  const apiKey = config && config.apiKey ? String(config.apiKey) : '';
  const maxBody = (config && config.maxBodyBytes) || 1024 * 1024;
  const publicPaths = new Set(['/healthz', '/statsz']);

  const routes = [
    ['GET', '/healthz', () => ({ status: 200, body: { status: 'ok', ts: nowIso() } })],
    ['GET', '/statsz', () => ({ status: 200, body: counter.snapshot() })],
    ['GET', '/api/agents', () => ({ status: 200, body: store.listAgents() })],
    ['GET', '/api/agents/:id', (p) => {
      const a = store.getAgent(p.id);
      if (!a) return { status: 404, body: { message: 'not found', agentId: p.id } };
      return { status: 200, body: a };
    }],
    ['GET', '/api/agents/:id/tasks', (p) => {
      if (!store.getAgent(p.id)) return { status: 404, body: { message: 'not found', agentId: p.id } };
      return { status: 200, body: store.listTasks(p.id) };
    }],
    ['GET', '/api/costs/summary', () => ({ status: 200, body: store.costSummary() })],
    ['POST', '/api/agents/heartbeat', (_p, body) => {
      const r = store.applyHeartbeat(body);
      if (!r.ok) return { status: 400, body: { message: 'bad heartbeat payload', reason: r.reason } };
      counter.heartbeat(r.agent.agentId);
      return { status: 200, body: { ok: true, agentId: r.agent.agentId, agent: r.agent } };
    }],
    ['POST', '/api/tasks', (_p, body) => {
      const b = body || {};
      if (!store.getAgent(b.agentId)) {
        return { status: 404, body: { message: 'agent not found', agentId: String(b.agentId || '') } };
      }
      const r = store.createTask({ agentId: b.agentId, title: b.title });
      if (!r.ok) return { status: 400, body: { message: r.reason } };
      counter.bump('tasksCreated');
      return { status: 200, body: { ok: true, task: r.task, titleTruncated: r.titleTruncated } };
    }],
    ['POST', '/api/tasks/:id/claim', (p, body) => {
      const r = store.claimTask(p.id, (body || {}).claimedBy);
      if (!r.ok) {
        const status = r.reason === 'not_found' ? 404 : 409;
        return { status, body: { message: r.reason, ...(r.status ? { status: r.status } : {}) } };
      }
      counter.bump('tasksClaimed');
      return { status: 200, body: { ok: true, task: r.task } };
    }],
    ['POST', '/api/tasks/:id/complete', (p, body) => {
      const r = store.completeTask(p.id, body || {});
      if (!r.ok) {
        const status = r.reason === 'not_found' ? 404 : (r.reason === 'bad_status' ? 400 : 409);
        return { status, body: { message: r.reason, ...(r.allowed ? { allowed: r.allowed } : {}), ...(r.status ? { status: r.status } : {}) } };
      }
      counter.bump('tasksCompleted');
      return { status: 200, body: { ok: true, task: r.task } };
    }],
  ];

  function resolve(method, pathname) {
    for (const [m, pattern, fn] of routes) {
      if (m !== method) continue;
      const hit = matchRoute(pattern, pathname);
      if (hit) return { fn, params: hit.params, route: `${m} ${pattern}` };
    }
    return null;
  }

  function handler(req, res) {
    const started = now();
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch {
      counter.request('bad-url', 400);
      sendJson(res, 400, { message: 'bad request' });
      return;
    }
    const pathname = url.pathname.length > MAX_PATH ? url.pathname.slice(0, MAX_PATH) : url.pathname;
    const ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
    const entry = { method: req.method, path: pathname, ip };

    // 请求体上限：先回 413 再断链，客户端才看得到原因（见 wechat-bridge 同款处理）
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBody) {
      entry.status = 413;
      counter.request(`${req.method} ${pathname}`, 413);
      recorder.record(entry);
      rejectTooLarge(req, res);
      return;
    }

    const gate = limiter.check(ip || 'unknown');
    if (!gate.ok) {
      entry.status = 429;
      entry.retryAfterMs = gate.retryAfterMs;
      counter.request(`${req.method} ${pathname}`, 429);
      counter.bump('rateLimited');
      recorder.record(entry);
      sendJson(res, 429, { message: 'rate limited', retryAfterMs: gate.retryAfterMs });
      return;
    }

    // 面板走自己的会话 Cookie 鉴权，与 /api/* 的 Bearer 是两条独立的门。
    // 放在限流之后、Bearer 门之前：面板因此也受每 IP 限流与全量审计约束，
    // 且不会被「缺 Bearer 头就 401」挡在登录页之外。
    const panelHit = panel ? panel.match(req.method, pathname) : null;
    if (panelHit) {
      readBody(req, maxBody).then((body) => {
        let out;
        try {
          out = panelHit.fn(body, req, ip);
        } catch (e) {
          entry.status = 500;
          entry.error = String((e && e.message) || e);
          counter.request(panelHit.route, 500);
          recorder.record(entry);
          log.error('panel route threw', { route: panelHit.route, error: entry.error });
          sendJson(res, 500, { message: 'internal error' });
          return;
        }
        entry.status = out.status;
        entry.ms = now() - started;
        counter.request(panelHit.route, out.status);
        recorder.record(entry);
        if (out.headers && out.headers['Content-Type']) {
          // 页面是 HTML，不能走 sendJson 的 JSON 序列化
          const text = String(out.body);
          try {
            res.writeHead(out.status, {
              'Content-Type': out.headers['Content-Type'],
              'Content-Length': Buffer.byteLength(text),
              'Cache-Control': 'no-store',
              ...(out.headers['Set-Cookie'] ? { 'Set-Cookie': out.headers['Set-Cookie'] } : {}),
            });
            res.end(text);
          } catch { /* 客户端已断开 */ }
          return;
        }
        sendJson(res, out.status, out.body, out.headers);
      }).catch((e) => {
        entry.status = 400;
        entry.error = String((e && e.message) || e);
        counter.request(panelHit.route, 400);
        recorder.record(entry);
        sendJson(res, 400, { message: 'bad request' });
      });
      return;
    }

    const hit = resolve(req.method, pathname);
    if (!hit) {
      entry.status = 404;
      counter.request(`${req.method} ${pathname}`, 404);
      recorder.record(entry);
      sendJson(res, 404, { message: 'no route ' + req.method + ' ' + pathname });
      return;
    }

    const needsAuth = !publicPaths.has(pathname);
    if (needsAuth && apiKey) {
      const auth = String(req.headers.authorization || '');
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!supplied || !safeEqual(supplied, apiKey)) {
        entry.status = 401;
        counter.request(hit.route, 401);
        counter.bump('unauthorized');
        recorder.record(entry);
        log.warn('unauthorized', { path: pathname, ip });
        sendJson(res, 401, { message: 'unauthorized' });
        return;
      }
    } else if (needsAuth && !apiKey) {
      // 理论上进不来：parseConfig 已强制 MC_API_KEY 非空。双保险，fail-closed。
      entry.status = 503;
      counter.request(hit.route, 503);
      recorder.record(entry);
      sendJson(res, 503, { message: 'server misconfigured: MC_API_KEY missing' });
      return;
    }

    readBody(req, maxBody).then((body) => {
      let out;
      try {
        out = hit.fn(hit.params, body);
      } catch (e) {
        entry.status = 500;
        entry.error = String((e && e.message) || e);
        counter.request(hit.route, 500);
        recorder.record(entry);
        log.error('route threw', { route: hit.route, error: entry.error });
        sendJson(res, 500, { message: 'internal error' });
        return;
      }
      entry.status = out.status;
      entry.ms = now() - started;
      counter.request(hit.route, out.status);
      recorder.record(entry);
      sendJson(res, out.status, out.body);
    }).catch((e) => {
      const status = e && e.code === 'ETOOLARGE' ? 413 : (e && e.code === 'EBADJSON' ? 400 : 400);
      entry.status = status;
      entry.error = String((e && e.message) || e);
      counter.request(hit.route, status);
      recorder.record(entry);
      if (e && e.code === 'ETOOLARGE') {
        rejectTooLarge(req, res);
        return;
      }
      sendJson(res, status, { message: status === 400 && e && e.code === 'EBADJSON' ? 'invalid json' : 'bad request' });
    });
  }

  // 一个 http.Server 实例只能 listen 一次（Node 对重复 listen 直接抛错），
  // 所以多地址监听要为每个地址各建一个实例，共享同一个 handler。
  const servers = [];
  function newServer() {
    const s = httpImpl.createServer(handler);
    // 裸 TCP 写半个请求就断开的场景：不让 error 事件打崩进程
    s.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      log.debug('clientError', { error: String(err && err.message || err) });
    });
    s.on('error', (err) => log.error('server error', { error: String(err && err.message || err) }));
    servers.push(s);
    return s;
  }
  const server = newServer();

  return {
    server,
    handler,
    panel,
    stats: counter,
    audit: recorder,
    routes: routes.map(([m, p]) => `${m} ${p}`),
    // host 可以是字符串或字符串数组：本机组件走回环、外部联调走公网网卡，
    // 两条路同时活着。改成只听一个地址时，原先走另一条路的本机组件会静默断线——
    // Sidecar 的心跳、桥的命令转发都是这样失败的，日志里只有连接错误。
    listen: (port, host) => {
      const list = (Array.isArray(host) ? host : [host]).filter((h) => h !== undefined && h !== null && h !== '');
      const targets = list.length > 0 ? list : ['127.0.0.1'];
      const bound = [];
      // port 为 0（测试/临时）时，第一个地址定下端口，其余地址必须沿用同一个：
      // 各绑各的随机端口，多地址就变成了多个互不相干的服务。
      let actualPort = port;
      return (async () => {
        for (let i = 0; i < targets.length; i++) {
          const s = i === 0 ? server : newServer();
          // eslint-disable-next-line no-await-in-loop -- 地址按顺序绑，任一失败即整体回滚
          await new Promise((resolve, reject) => {
            s.once('error', reject);
            s.listen(actualPort, targets[i], () => {
              s.removeListener('error', reject);
              if (port === 0) actualPort = s.address().port;
              log.info('listening', { host: targets[i], port: actualPort, pid: process.pid });
              bound.push(s);
              resolve();
            });
          });
        }
        return server;
      })().catch((e) => {
        // 有一个地址绑不上就整体失败：半开状态下已绑好的地址会继续服务，
        // 而运维看到的是「服务起来了」，比启动失败更难排查。
        for (const s of bound) {
          try { s.close(); } catch { /* 已关闭 */ }
        }
        servers.length = 0;
        servers.push(server);
        throw e;
      });
    },
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => {
      s.close(() => resolve());
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      setTimeout(resolve, 3000).unref();
    }))).then(() => {}),
  };
}

module.exports = { createControlServer, matchRoute, readBody, sendJson, safeEqual };
