'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMcClient } = require('../src/mc-client');

function stubFetch(responder) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
  return { impl, calls };
}

function jsonRes(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); },
  };
}

test('GET 带 Bearer 头并解析 JSON', async () => {
  const { impl, calls } = stubFetch(() => jsonRes(200, { a: 1 }));
  const mc = createMcClient({ base: 'http://mc:3000/', apiKey: 'k', fetchImpl: impl });
  const d = await mc.get('/api/agents');
  assert.deepEqual(d, { a: 1 });
  assert.equal(calls[0].url, 'http://mc:3000/api/agents');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].opts.method, 'GET');
});

test('POST 带 body', async () => {
  const { impl, calls } = stubFetch(() => jsonRes(200, { ok: true }));
  const mc = createMcClient({ base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl });
  await mc.post('/api/tasks', { agentId: 'a' });
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, '{"agentId":"a"}');
});

test('非 2xx 抛错带状态码', async () => {
  const { impl } = stubFetch(() => jsonRes(401, { message: 'nope' }));
  const mc = createMcClient({ base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl });
  await assert.rejects(() => mc.get('/api/agents'), (e) => e.status === 401 && /401/.test(e.message));
});

test('非 JSON 响应原样返回', async () => {
  const { impl } = stubFetch(() => ({ ok: true, status: 200, async text() { return 'plain'; } }));
  const mc = createMcClient({ base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl });
  assert.equal(await mc.get('/x'), 'plain');
});

test('缺少配置直接报错', () => {
  assert.throws(() => createMcClient({ apiKey: 'k' }), /MC_BASE/);
  assert.throws(() => createMcClient({ base: 'http://x' }), /MC_API_KEY/);
});
