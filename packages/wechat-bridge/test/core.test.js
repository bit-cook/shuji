'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../src/core');
const { createConfirmStore } = require('../src/confirm');

function fakeMc(overrides = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      if (overrides.get) return overrides.get(path);
      if (path === '/api/agents') return [{ agentId: 'node-a', status: 'online', model: 'gpt' }, { id: 'node-b', status: 'offline' }];
      if (path === '/api/agents/node-a') return { agentId: 'node-a', status: 'online' };
      if (path === '/api/agents/node-a/tasks') return [{ id: 1, title: 'x' }];
      if (path === '/api/costs/summary') return { totalTokens: 1234 };
      throw new Error('404 ' + path);
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (overrides.post) return overrides.post(path, body);
      return { ok: true, id: 't-1', ...body };
    },
  };
}

function makeRouter(mc, opts = {}) {
  const auditLog = [];
  const router = createRouter({
    mc,
    allowFrom: opts.allowFrom || ['me'],
    audit: { record: (e) => auditLog.push(e) },
    now: opts.now || (() => 1700000000000),
    isoNow: opts.isoNow || (() => '2026-01-01T00:00:00.000Z'),
    confirmStore: opts.confirmStore,
  });
  return { router, auditLog };
}

test('白名单之外一律拒绝并留痕', async () => {
  const { router, auditLog } = makeRouter(fakeMc());
  const r = await router.handle('/list', 'stranger');
  assert.match(r, /拒绝访问/);
  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].result, 'denied');
  assert.equal(auditLog[0].from, 'stranger');
});

test('/ping 返回 pong 与时间戳', async () => {
  const { router } = makeRouter(fakeMc());
  const r = await router.handle('/ping', 'me');
  assert.match(r, /^pong · 2026-01-01T00:00:00\.000Z$/);
});

test('/list 汇总全部 Agent', async () => {
  const mc = fakeMc();
  const { router } = makeRouter(mc);
  const r = await router.handle('/list', 'me');
  assert.match(r, /node-a \[online\] gpt/);
  assert.match(r, /node-b \[offline\]/);
  assert.deepEqual(mc.calls[0], ['GET', '/api/agents']);
});

test('/status /tasks /cost 走对应 REST', async () => {
  const mc = fakeMc();
  const { router } = makeRouter(mc);
  await router.handle('/status node-a', 'me');
  await router.handle('/tasks node-a', 'me');
  const cost = await router.handle('/cost', 'me');
  assert.match(cost, /totalTokens/);
  const paths = mc.calls.map((c) => c[1]);
  assert.deepEqual(paths, ['/api/agents/node-a', '/api/agents/node-a/tasks', '/api/costs/summary']);
});

test('/dispatch 先要令牌，确认后才真正下发', async () => {
  const mc = fakeMc();
  const { router, auditLog } = makeRouter(mc);
  const pending = await router.handle('/dispatch node-a 跑一次巡检', 'me');
  const m = pending.match(/\/confirm ([0-9A-F]{8,})/);
  assert.ok(m, '应返回确认令牌: ' + pending);
  assert.equal(mc.calls.length, 0, '未确认前不得调用管理面');
  assert.equal(auditLog.at(-1).result, 'confirm_required');

  const wrong = await router.handle('/confirm 00000000', 'me');
  assert.match(wrong, /确认失败/);

  const other = await router.handle('/dispatch node-a 跑一次巡检', 'me');
  const m2 = other.match(/\/confirm ([0-9A-F]{8,})/);
  // 另一名白名单用户拿别人的令牌：发起人不匹配
  const { router: r2 } = makeRouter(fakeMc(), { allowFrom: ['me', 'you'] });
  const p2 = await r2.handle('/dispatch node-a y', 'me');
  const tok2 = p2.match(/\/confirm ([0-9A-F]{8,})/)[1];
  const mismatch = await r2.handle(`/confirm ${tok2}`, 'you');
  assert.match(mismatch, /令牌与发起人不一致/);
  assert.equal(m2 !== null, true);

  const done = await router.handle(`/confirm ${m[1]}`, 'me');
  assert.match(done, /已下发/);
  assert.deepEqual(mc.calls.at(-1), ['POST', '/api/tasks', { agentId: 'node-a', title: '跑一次巡检', createdAt: 1700000000000 }]);
  // 令牌一次性
  const again = await router.handle(`/confirm ${m[1]}`, 'me');
  assert.match(again, /确认失败/);
});

test('确认令牌 60 秒后过期', async () => {
  let t = 1000;
  const confirmStore = createConfirmStore({ ttlMs: 60000, now: () => t });
  const { router } = makeRouter(fakeMc(), { confirmStore });
  const pending = await router.handle('/dispatch node-a x', 'me');
  const token = pending.match(/\/confirm ([0-9A-F]{8,})/)[1];
  t += 60001;
  const r = await router.handle(`/confirm ${token}`, 'me');
  assert.match(r, /确认已过期/);
});

test('管理面报错时转成可读文案且不崩溃', async () => {
  const mc = { async get() { const e = new Error('管理面返回 401'); throw e; }, async post() { throw new Error('x'); } };
  const { router, auditLog } = makeRouter(mc);
  const r = await router.handle('/list', 'me');
  assert.match(r, /处理失败：管理面返回 401/);
  assert.equal(auditLog.at(-1).result, 'error');
});

test('/dispatch 打到未注册 Agent 时提示未找到，而不是暴露 404', async () => {
  const err = Object.assign(new Error('管理面返回 404'), { status: 404 });
  const mc = { ...fakeMc(), async post() { throw err; } };
  const { router, auditLog } = makeRouter(mc);
  const pending = await router.handle('/dispatch ghost 跑一次', 'me');
  const token = pending.match(/\/confirm ([0-9A-F]{8,})/)[1];
  const r = await router.handle(`/confirm ${token}`, 'me');
  assert.match(r, /未找到 Agent：ghost/);
  assert.equal(auditLog.at(-1).result, 'error');
});

test('/dispatch 成功后提示标题被控制面截断', async () => {
  const mc = { ...fakeMc(), async post() { return { ok: true, task: { id: 't-1' }, titleTruncated: true }; } };
  const { router } = makeRouter(mc);
  const pending = await router.handle('/dispatch node-a ' + 'x'.repeat(20), 'me');
  const token = pending.match(/\/confirm ([0-9A-F]{8,})/)[1];
  const r = await router.handle(`/confirm ${token}`, 'me');
  assert.match(r, /已下发/);
  assert.match(r, /已按上限截断/);
});

test('/dispatch 其他错误仍原样透出', async () => {
  const err = Object.assign(new Error('管理面返回 500'), { status: 500 });
  const mc = { ...fakeMc(), async post() { throw err; } };
  const { router } = makeRouter(mc);
  const pending = await router.handle('/dispatch node-a x', 'me');
  const token = pending.match(/\/confirm ([0-9A-F]{8,})/)[1];
  const r = await router.handle(`/confirm ${token}`, 'me');
  assert.match(r, /处理失败：管理面返回 500/);
});

test('未知命令返回用法', async () => {
  const { router } = makeRouter(fakeMc());
  const r = await router.handle('/nope', 'me');
  assert.match(r, /未知命令/);
  assert.match(r, /\/dispatch <id> <任务>/);
});

test('超长回复被截断（微信 2048 字节上限）', async () => {
  const long = Array.from({ length: 500 }, (_, i) => ({ agentId: 'agent-' + i, status: 'online' }));
  const { router } = makeRouter(fakeMc({ get: () => long }));
  const r = await router.handle('/list', 'me');
  assert.ok(r.length <= 1520, 'len=' + r.length);
  assert.match(r, /已截断/);
});
