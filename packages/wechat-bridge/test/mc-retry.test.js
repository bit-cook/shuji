'use strict';
/**
 * Mission-Control 客户端韧性：GET 可重试、POST 绝不重试、401 立即失败。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMcClient } = require('../src/mc-client');

function res(status, data) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(data); } };
}

test('GET：网络错误后重试并成功（读操作幂等）', async () => {
  let n = 0;
  const impl = async () => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    return res(200, { ok: true });
  };
  const slept = [];
  const mc = createMcClient({
    base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl,
    attempts: 2, sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
  });
  assert.deepEqual(await mc.get('/api/agents'), { ok: true });
  assert.equal(n, 2);
  assert.deepEqual(slept, [250]);
});

test('GET：5xx 重试后仍失败则抛错', async () => {
  let n = 0;
  const impl = async () => { n++; return res(503, { message: 'down' }); };
  const slept = [];
  const mc = createMcClient({
    base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl,
    attempts: 3, sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
  });
  await assert.rejects(() => mc.get('/api/agents'), (e) => e.status === 503);
  assert.equal(n, 3, '3 次尝试');
  assert.deepEqual(slept, [250, 500], '退避递增');
});

test('GET：401 不重试（密钥错误重试无益）', async () => {
  let n = 0;
  const impl = async () => { n++; return res(401, { message: 'bad key' }); };
  const mc = createMcClient({ base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl, attempts: 3, sleepImpl: () => Promise.resolve() });
  await assert.rejects(() => mc.get('/api/agents'), (e) => e.status === 401);
  assert.equal(n, 1);
});

test('POST：5xx 也不重试（/api/tasks 重试会产生重复任务）', async () => {
  let n = 0;
  const impl = async () => { n++; return res(500, {}); };
  const mc = createMcClient({ base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl, attempts: 3, sleepImpl: () => Promise.resolve() });
  await assert.rejects(() => mc.post('/api/tasks', { agentId: 'a' }), (e) => e.status === 500);
  assert.equal(n, 1, 'POST 只尝试一次');
});

test('attempts=1 时完全不重试', async () => {
  let n = 0;
  const impl = async () => { n++; return res(500, {}); };
  const mc = createMcClient({ base: 'http://mc:3000', apiKey: 'k', fetchImpl: impl, attempts: 1, sleepImpl: () => Promise.resolve() });
  await assert.rejects(() => mc.get('/api/agents'), (e) => e.status === 500);
  assert.equal(n, 1);
});
