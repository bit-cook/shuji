'use strict';
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { createControlServer, matchRoute, safeEqual } = require('../src/server');
const { createStore } = require('../src/store');
const { createLogger, createNoopLogger } = require('../src/log');
const { createAudit } = require('../src/audit');
const { createStats } = require('../src/stats');
const { createRateLimiter } = require('../src/ratelimit');

const KEY = 'k'.repeat(40);
const BASE_CFG = {
  apiKey: KEY, maxBodyBytes: 1024 * 1024, rateLimitPerMin: 600, rateLimitBurst: 200,
};

let tmpDir;
let seq = 0;
let http;
let store;
let base;
let stats;

function boot(overrides = {}) {
  seq += 1;
  const cfg = { ...BASE_CFG, ...(overrides.config || {}) };
  store = createStore({
    dbPath: path.join(tmpDir, `srv-${seq}.db`),
    now: overrides.now || (() => Date.now()),
    staleSec: overrides.staleSec ?? 900,
    tasksPerAgent: overrides.tasksPerAgent ?? 500,
    maxTaskTitle: overrides.maxTaskTitle ?? 4000,
  });
  stats = createStats({ now: overrides.now });
  http = createControlServer({
    config: cfg,
    store,
    logger: createNoopLogger(),
    stats,
    audit: createAudit({ file: 'none' }),
    rateLimiter: createRateLimiter({
      perMinute: cfg.rateLimitPerMin, burst: cfg.rateLimitBurst, now: overrides.now,
    }),
    now: overrides.now || (() => Date.now()),
  });
  return http.listen(0, '127.0.0.1').then(() => {
    base = `http://127.0.0.1:${http.server.address().port}`;
    return http;
  });
}

async function api(method, pathName, { body, token = KEY, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  const res = await fetch(base + pathName, {
    method, headers, body: payload,
  });
  const text = await res.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* 保持原文 */ }
  return { status: res.status, body: json, text };
}

function hb(agentId, status = 'online', extra = {}) {
  return { framework: 'generic', action: 'heartbeat', payload: { agentId, status, reportedAt: Date.now(), ...extra } };
}

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-mc-http-')); });
beforeEach(async () => { await boot(); });
// 每个用例结束必须关库关服务：泄漏的 server 会让 node:test 一直等事件循环排空
afterEach(async () => {
  if (http) { await http.close(); http = null; }
  if (store) { store.close(); store = null; }
});
after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('路由匹配', () => {
  test('静态与参数段都能匹配', () => {
    assert.deepEqual(matchRoute('/api/agents', '/api/agents'), { params: {} });
    assert.deepEqual(matchRoute('/api/agents/:id', '/api/agents/node-b'), { params: { id: 'node-b' } });
    assert.deepEqual(matchRoute('/api/agents/:id/tasks', '/api/agents/node-b/tasks'), { params: { id: 'node-b' } });
    assert.deepEqual(matchRoute('/api/tasks/:id/claim', '/api/tasks/t1/claim'), { params: { id: 't1' } });
  });

  test('段数不同或字面不同不匹配', () => {
    assert.equal(matchRoute('/api/agents', '/api/agents/x'), null);
    assert.equal(matchRoute('/api/agents/:id', '/api/agent/x'), null);
    assert.equal(matchRoute('/api/agents/:id/tasks', '/api/agents/x/task'), null);
  });

  test('空参数段不匹配', () => {
    assert.equal(matchRoute('/api/agents/:id', '/api/agents/'), null);
  });

  test('URL 编码的参数被解码', () => {
    assert.deepEqual(matchRoute('/api/agents/:id', '/api/agents/a%2Fb'), { params: { id: 'a/b' } });
  });

  test('safeEqual 常数时间比较', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
  });
});

describe('探针', () => {
  test('/healthz 免鉴权', async () => {
    const r = await api('GET', '/healthz', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });

  test('/statsz 免鉴权且只含计数', async () => {
    const r = await api('GET', '/statsz', { token: null });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.requests, 'number');
    assert.ok(!JSON.stringify(r.body).includes(KEY), '快照不得泄漏 API Key');
  });

  test('未知路径 404', async () => {
    const r = await api('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.match(r.body.message, /no route/);
  });

  test('方法不匹配 404（POST 到只读路径）', async () => {
    const r = await api('POST', '/api/agents');
    assert.equal(r.status, 404);
  });
});

describe('Bearer 鉴权', () => {
  test('无令牌 401 且留痕', async () => {
    const r = await api('GET', '/api/agents', { token: null });
    assert.equal(r.status, 401);
    assert.equal(stats.snapshot().unauthorized, 1);
  });

  test('错令牌 401', async () => {
    const r = await api('GET', '/api/agents', { token: 'wrong' });
    assert.equal(r.status, 401);
  });

  test('非 Bearer  scheme 401', async () => {
    const r = await api('GET', '/api/agents', { token: null, raw: undefined });
    const res = await fetch(base + '/api/agents', { headers: { Authorization: 'Basic ' + KEY } });
    assert.equal(res.status, 401);
    assert.equal(r.status, 401);
  });

  test('令牌前后空格被修剪', async () => {
    const res = await fetch(base + '/api/agents', { headers: { Authorization: 'Bearer  ' + KEY + ' ' } });
    assert.equal(res.status, 200);
  });

  test('正确令牌 200', async () => {
    const r = await api('GET', '/api/agents');
    assert.equal(r.status, 200);
  });
});

describe('Agent 查询', () => {
  test('空库 /api/agents 返回空数组', async () => {
    const r = await api('GET', '/api/agents');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('心跳后 /api/agents 出现该 Agent', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('hermes-node-b') });
    const r = await api('GET', '/api/agents');
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].agentId, 'hermes-node-b');
    assert.equal(r.body[0].status, 'online');
  });

  test('未知 Agent 单个查询 404', async () => {
    const r = await api('GET', '/api/agents/ghost');
    assert.equal(r.status, 404);
    assert.equal(r.body.message, 'not found');
  });

  test('未知 Agent 的 tasks 查询 404（桥侧转「未找到 Agent」）', async () => {
    const r = await api('GET', '/api/agents/ghost/tasks');
    assert.equal(r.status, 404);
  });

  test('已注册 Agent 无任务时 tasks 返回空数组', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('a') });
    const r = await api('GET', '/api/agents/a/tasks');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('心跳坏报文 400 而不是 500', async () => {
    const r = await api('POST', '/api/agents/heartbeat', { body: { nope: 1 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'bad_payload');
  });

  test('心跳体非 JSON 400', async () => {
    const r = await api('POST', '/api/agents/heartbeat', { raw: 'not-json' });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'invalid json');
  });
});

describe('任务下发与回收', () => {
  test('POST /api/tasks 创建 pending 任务', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('node-b') });
    const r = await api('POST', '/api/tasks', { body: { agentId: 'node-b', title: '夜间巡检一次', createdAt: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.task.agentId, 'node-b');
    assert.equal(r.body.task.status, 'pending');
    assert.match(r.body.task.id, /^task-/);
  });

  test('给未注册 Agent 下发任务 404（防任务静默进无人轮询的队列）', async () => {
    const r = await api('POST', '/api/tasks', { body: { agentId: 'ghost', title: 'x' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.message, 'agent not found');
  });

  test('缺标题 400', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('a') });
    const r = await api('POST', '/api/tasks', { body: { agentId: 'a' } });
    assert.equal(r.status, 400);
  });

  test('claim → complete 完整链路', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('a') });
    const created = await api('POST', '/api/tasks', { body: { agentId: 'a', title: 't' } });
    const id = created.body.task.id;
    const claimed = await api('POST', `/api/tasks/${id}/claim`, { body: { claimedBy: 'w1' } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.task.status, 'running');
    const again = await api('POST', `/api/tasks/${id}/claim`, { body: { claimedBy: 'w2' } });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'not_pending');
    const done = await api('POST', `/api/tasks/${id}/complete`, { body: { status: 'done', tokens: 42, costUsd: 0.01 } });
    assert.equal(done.status, 200);
    assert.equal(done.body.task.status, 'done');
    assert.equal(done.body.task.usage.tokens, 42);
    const twice = await api('POST', `/api/tasks/${id}/complete`, { body: { status: 'failed' } });
    assert.equal(twice.status, 409);
  });

  test('claim / complete 未知任务 404', async () => {
    assert.equal((await api('POST', '/api/tasks/nope/claim', { body: {} })).status, 404);
    assert.equal((await api('POST', '/api/tasks/nope/complete', { body: {} })).status, 404);
  });

  test('complete 非法状态 400 且不动任务', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('a') });
    const id = (await api('POST', '/api/tasks', { body: { agentId: 'a', title: 't' } })).body.task.id;
    const r = await api('POST', `/api/tasks/${id}/complete`, { body: { status: 'running' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.allowed, ['done', 'failed', 'cancelled']);
    assert.equal((await api('GET', `/api/agents/a/tasks`)).body[0].status, 'pending');
  });

  test('超长标题被截断并回带 titleTruncated', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('a') });
    const r = await api('POST', '/api/tasks', { body: { agentId: 'a', title: 'x'.repeat(9000) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.titleTruncated, true);
    assert.equal(r.body.task.title.length, 4000);
  });
});

describe('成本汇总', () => {
  test('/api/costs/summary 聚合心跳与任务用量', async () => {
    await api('POST', '/api/agents/heartbeat', { body: hb('a', 'online', { detail: { usage: { tokens: 100, costUsd: 0.5 } } }) });
    const id = (await api('POST', '/api/tasks', { body: { agentId: 'a', title: 't' } })).body.task.id;
    await api('POST', `/api/tasks/${id}/complete`, { body: { status: 'done', tokens: 900, costUsd: 1.5 } });
    const r = await api('GET', '/api/costs/summary');
    assert.equal(r.status, 200);
    assert.equal(r.body.totalTokens, 1000);
    assert.equal(r.body.totalCostUsd, 2);
    assert.equal(r.body.byAgent.a.tokens, 1000);
    assert.equal(r.body.taskCount, 1);
  });
});

describe('韧性', () => {
  test('超过 maxBodyBytes 的请求体 413 后服务照常', async () => {
    const big = JSON.stringify({ agentId: 'a', title: 'x'.repeat(2 * 1024 * 1024) });
    const res = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: big,
    });
    assert.equal(res.status, 413);
    const after = await api('GET', '/api/agents');
    assert.equal(after.status, 200);
  });

  test('Content-Length 超限时先回 413 再断链（客户端看得到原因）', async () => {
    // 用裸 socket：fetch 会校验 body 实际长度与声明的 Content-Length 是否一致，
    //  artificially 声明一个大于实际长度的值只会让客户端自己报错，测不到服务端行为。
    const statusLine = await new Promise((resolve, reject) => {
      const sock = net.connect(http.server.address().port, '127.0.0.1', () => {
        sock.write(
          'POST /api/tasks HTTP/1.1\r\nHost: x\r\n' +
          `Authorization: Bearer ${KEY}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${5 * 1024 * 1024}\r\n\r\n`,
        );
      });
      let buf = '';
      sock.on('data', (c) => { buf += c.toString('utf8'); if (buf.includes('\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); } });
      sock.on('error', reject);
      // 超时给宽一点：这个测试等的是「服务端在收 body 之前就回 413」，
      // 而机器负载高时 3 秒不够，会把一条稳定的断言变成偶发红。
      setTimeout(() => { sock.destroy(); reject(new Error('no response')); }, 15000).unref();
    });
    assert.match(statusLine, /^HTTP\/1\.1 413/);
    const after = await api('GET', '/api/agents');
    assert.equal(after.status, 200);
  });

  test('裸 TCP 写半个请求就断开不会打崩进程', async () => {
    const sock = net.connect(http.server.address().port, '127.0.0.1', () => {
      sock.write('POST /api/tasks HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"a"');
      setTimeout(() => sock.destroy(), 20);
    });
    await new Promise((r) => sock.on('close', r));
    const after = await api('GET', '/healthz', { token: null });
    assert.equal(after.status, 200);
  });

  test('限流生效：超突发后 429，恢复后可再用', async () => {
    await http.close();
    await boot({ config: { rateLimitPerMin: 60, rateLimitBurst: 2 } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await api('GET', '/api/agents')).status);
    assert.equal(codes.filter((c) => c === 200).length, 2);
    assert.equal(codes.filter((c) => c === 429).length, 3);
    assert.ok(stats.snapshot().rateLimited >= 3);
  });

  test('statsz 记录路由与状态分布', async () => {
    await api('GET', '/api/agents');
    await api('GET', '/api/ghost');
    const s = stats.snapshot();
    assert.ok(s.byRoute['GET /api/agents'] >= 1);
    assert.ok(s.byStatus['200'] >= 1);
    assert.ok(s.byStatus['404'] >= 1);
  });
});

describe('审计', () => {
  test('审计记录元数据但不含请求体与令牌', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    await http.close();
    http = null;
    store.close();
    store = null;
    seq += 1;
    const s2 = createStore({ dbPath: path.join(tmpDir, `audit-${seq}.db`) });
    const h2 = createControlServer({
      config: BASE_CFG,
      store: s2,
      logger: createNoopLogger(),
      stats: createStats(),
      audit: createAudit({ file }),
      rateLimiter: createRateLimiter({ perMinute: 0 }),
    });
    await h2.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${h2.server.address().port}`;
    await fetch(url + '/api/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(hb('secret-agent', 'online', { detail: { apiToken: 'SUPER_SECRET' } })),
    });
    await h2.close();
    s2.close();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 1);
    const joined = JSON.stringify(lines);
    assert.ok(joined.includes('/api/agents/heartbeat'));
    assert.ok(!joined.includes('SUPER_SECRET'), '审计不得记录请求体');
    assert.ok(!joined.includes(KEY), '审计不得记录令牌');
    assert.ok(lines.every((l) => typeof l.status === 'number'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
