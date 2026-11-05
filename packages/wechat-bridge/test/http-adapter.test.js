'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
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

/**
 * 用裸 TCP 按给定分段发一个 HTTP 请求，收集响应。
 * fetch 无法控制分段边界，跨块场景必须自己写 socket。
 */
function rawPost(port, path, headers, segments) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.setEncoding('latin1');
    sock.on('data', (d) => {
      buf += d;
      if (/invalid json|internal error/.test(buf) || /"reply"/.test(buf)) {
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on('error', reject);
    let i = 0;
    const writeNext = () => {
      if (sock.destroyed) return;
      sock.write(segments[i++]);
      if (i < segments.length) setTimeout(writeNext, 30);
    };
    sock.on('connect', writeNext);
    setTimeout(() => { sock.destroy(); reject(new Error('raw request 超时，响应：' + buf)); }, 3000).unref();
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

test('HTTP 适配器：多字节 UTF-8 被 TCP 分块切开时仍无损解码', async () => {
  // 审计记录命令原文：跨块损坏的正确观测点是原文本身——U+FFFD 出现在 JSON 字符串
  // 值内部时 JSON.parse 照样成功（客户端看到的是 200），坏在数据里。
  const audited = [];
  const router = createRouter({
    mc: { async get() { return []; }, async post() { return {}; } },
    allowFrom: ['me'],
    audit: { record: (e) => audited.push(e) },
    isoNow: () => '2026-01-01T00:00:00.000Z',
  });
  const adapter = createHttpAdapter({ router });
  const server = listen({ handler: adapter.handler, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  // 断言失败也必须关掉服务器：泄漏的监听会让 node:test 等事件循环排空直到超时
  try {
    // 「枢」是 3 字节 UTF-8（E6 9E A2）：手工把请求体在它的字节中间切开，
    // 模拟 TCP 分段。逐块 toString 的话两半各自解码都变 U+FFFD。
    const prefix = Buffer.from('{"from":"me","text":"/ping 枢', 'utf8');
    const suffix = Buffer.from('机"}', 'utf8');
    const body = Buffer.concat([prefix, suffix]);
    const head = 'POST /message HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${body.length}\r\n\r\n`;
    const res = await rawPost(port, '/message', {}, [
      Buffer.concat([Buffer.from(head, 'latin1'), prefix.subarray(0, prefix.length - 1)]),
      Buffer.concat([prefix.subarray(prefix.length - 1), suffix]),
    ]);
    assert.match(res, /HTTP\/1\.1 200/);
    assert.match(res, /pong/);
    assert.doesNotMatch(res, /invalid json/);
    // 关键断言：到达命令核心的原文与发送的逐字节一致（审计留痕即证据）
    const entry = audited.find((e) => e.result === 'ok');
    assert.ok(entry, '命令应成功执行并留痕');
    assert.equal(entry.cmd, '/ping 枢机');
  } finally {
    await new Promise((r) => { server.closeAllConnections(); server.close(r); });
  }
});
