'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpAdapter } = require('../src/adapters/http');
const { createRouter } = require('../src/core');
const { listen } = require('../src/adapters/wecom');

function makeRouter() {
  return createRouter({
    mc: {
      async get(p) {
        if (p === '/api/agents') return [{ agentId: 'node-a', status: 'online' }];
        throw new Error('404');
      },
      async post() { return { ok: true, id: 't-9' }; },
    },
    allowFrom: ['me'],
    audit: { record() {} },
    isoNow: () => '2026-01-01T00:00:00.000Z',
  });
}

test('HTTP 适配器：/message 收发 + healthz + 404', async () => {
  const adapter = createHttpAdapter({ router: makeRouter() });
  const server = listen({ handler: adapter.handler, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await fetch(base + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'me', text: '/list' }),
  });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).reply, /node-a \[online\]/);

  const denied = await fetch(base + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'stranger', text: '/list' }),
  });
  assert.match((await denied.json()).reply, /拒绝访问/);

  const bad = await fetch(base + '/message', { method: 'POST', body: 'not-json' });
  assert.equal(bad.status, 400);

  const health = await fetch(base + '/healthz');
  assert.equal(await health.text(), 'ok');

  const nf = await fetch(base + '/other');
  assert.equal(nf.status, 404);

  await new Promise((r) => { server.closeAllConnections(); server.close(r); });
});

test('HTTP 适配器：/openclaw 端点（OpenClaw 插件入口）', async () => {
  const adapter = createHttpAdapter({ router: makeRouter() });
  const server = listen({ handler: adapter.handler, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/openclaw', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'me', text: '/ping' }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).reply, /^pong/);
  await new Promise((r) => { server.closeAllConnections(); server.close(r); });
});

test('HTTP 适配器：dispatch 二次确认全流程', async () => {
  const adapter = createHttpAdapter({ router: makeRouter() });
  const server = listen({ handler: adapter.handler, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (text) => (await (await fetch(base + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'me', text }),
  })).json()).reply;

  const pending = await post('/dispatch node-a 夜间巡检');
  const token = pending.match(/\/confirm ([0-9A-F]{8,})/)[1];
  assert.ok(token);
  const done = await post(`/confirm ${token}`);
  assert.match(done, /已下发/);

  await new Promise((r) => { server.closeAllConnections(); server.close(r); });
});
