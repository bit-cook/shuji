'use strict';
/**
 * HTTP 适配器安全与韧性：Bearer 鉴权、超大请求体、坏连接、/statsz。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createHttpAdapter } = require('../src/adapters/http');
const { createRouter } = require('../src/core');
const { createStats } = require('../src/stats');
const { listen } = require('../src/adapters/wecom');

function makeRouter() {
  return createRouter({
    mc: {
      async get(p) { if (p === '/api/agents') return [{ agentId: 'node-a', status: 'online' }]; throw new Error('404'); },
      async post() { return { ok: true }; },
    },
    allowFrom: ['me'],
    audit: { record() {} },
    isoNow: () => '2026-01-01T00:00:00.000Z',
  });
}

async function withServer(adapter, fn) {
  const server = listen({ handler: adapter.handler, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('配置 BRIDGE_TOKEN 后：无令牌 401，错令牌 401，对令牌 200', async () => {
  await withServer(createHttpAdapter({ router: makeRouter(), token: 's3cret' }), async (base) => {
    const post = (headers) => fetch(base + '/openclaw', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ from: 'me', text: '/ping' }),
    });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
    const ok = await post({ Authorization: 'Bearer s3cret' });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).reply, /^pong/);
  });
});

test('未配置令牌时不做鉴权（向后兼容）', async () => {
  await withServer(createHttpAdapter({ router: makeRouter() }), async (base) => {
    const res = await fetch(base + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me', text: '/ping' }),
    });
    assert.equal(res.status, 200);
  });
});

test('/statsz 暴露计数快照', async () => {
  const stats = createStats({ now: () => 1700000000000 });
  const router = createRouter({
    mc: { async get() { return []; }, async post() { return {}; } },
    allowFrom: ['me'], audit: { record() {} }, stats, isoNow: () => 'T',
  });
  await router.handle('/ping', 'me');
  await router.handle('/ping', 'stranger');
  await withServer(createHttpAdapter({ router, stats }), async (base) => {
    const s = await (await fetch(base + '/statsz')).json();
    assert.equal(s.commands, 2);
    assert.equal(s.denied, 1);
    assert.equal(s.startedAt, 1700000000000);
  });
});

test('超大请求体：回 413 且服务不崩（随后仍可正常服务）', async () => {
  await withServer(createHttpAdapter({ router: makeRouter(), maxBodyBytes: 1024 }), async (base) => {
    const big = await fetch(base + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me', text: '/ping', pad: 'x'.repeat(4096) }),
    });
    assert.equal(big.status, 413);
    const ok = await fetch(base + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me', text: '/ping' }),
    });
    assert.equal(ok.status, 200);
  });
});

test('裸 TCP 写垃圾后断开：服务存活（坏连接不打崩进程）', async () => {
  await withServer(createHttpAdapter({ router: makeRouter() }), async (base) => {
    const { port } = new URL(base);
    await new Promise((resolve, reject) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => {
        sock.write('POST /message HTTP/1.1\r\nContent-Length: 999999\r\n\r\n{"from":');
        setTimeout(() => { sock.destroy(); resolve(); }, 50);
      });
      sock.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    const ok = await fetch(base + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me', text: '/ping' }),
    });
    assert.equal(ok.status, 200);
  });
});

test('/openclaw 与 /message 在审计里带不同 channel', async () => {
  const auditLog = [];
  const router = createRouter({
    mc: { async get() { return []; }, async post() { return {}; } },
    allowFrom: ['me'], audit: { record: (e) => auditLog.push(e) }, isoNow: () => 'T',
  });
  await withServer(createHttpAdapter({ router }), async (base) => {
    for (const p of ['/openclaw', '/message']) {
      await fetch(base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'me', text: '/ping' }),
      });
    }
  });
  assert.deepEqual(auditLog.map((e) => e.channel), ['openclaw', 'http']);
});

test('from 为数字时也能命中白名单（JSON 里常见）', async () => {
  await withServer(createHttpAdapter({ router: createRouter({
    mc: { async get() { return []; }, async post() { return {}; } },
    allowFrom: ['12345'], audit: { record() {} }, isoNow: () => 'T',
  }) }), async (base) => {
    const res = await fetch(base + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 12345, text: '/ping' }),
    });
    assert.match((await res.json()).reply, /^pong/);
  });
});
