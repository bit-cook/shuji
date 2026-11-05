'use strict';
/**
 * 命令核心的补充单测：输入归一化、限流、统计、错误映射、响应形状。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouter, normalize, clip, toArray } = require('../src/core');
const { createConfirmStore } = require('../src/confirm');
const { createRateLimiter } = require('../src/ratelimit');
const { createStats } = require('../src/stats');

function fakeMc(overrides = {}) {
  return {
    async get(path) {
      if (overrides.get) return overrides.get(path);
      if (path === '/api/agents') return [{ agentId: 'node-a', status: 'online' }];
      throw new Error('404 ' + path);
    },
    async post() { return { ok: true }; },
  };
}

function makeRouter(opts = {}) {
  const auditLog = [];
  const stats = createStats({ now: () => 1700000000000 });
  const rateLimiter = createRateLimiter({ perMinute: opts.perMinute ?? 0, burst: opts.burst ?? 3, now: () => 1700000000000 });
  const router = createRouter({
    mc: opts.mc || fakeMc(),
    allowFrom: opts.allowFrom || ['me'],
    audit: { record: (e) => auditLog.push(e) },
    now: () => 1700000000000,
    isoNow: () => '2026-01-01T00:00:00.000Z',
    confirmStore: opts.confirmStore,
    rateLimiter,
    stats,
  });
  return { router, auditLog, stats };
}

test('normalize：全角斜杠 / 零宽字符 / 连续空白', () => {
  assert.equal(normalize('／ping'), '/ping');
  assert.equal(normalize('  /list  '), '/list');
  assert.equal(normalize('/dispatch a​b 跑一次'), '/dispatch ab 跑一次');
  assert.equal(normalize('/status\nnode-a'), '/status node-a');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('clip：按 UTF-8 字节截断（中文 3 字节/字）', () => {
  // 1500 字节上限：500 个中文字 = 1500 字节 → 不截断；501 个 → 截断
  assert.equal(clip('枢'.repeat(500)).length, 500);
  const clipped = clip('枢'.repeat(600));
  assert.match(clipped, /已截断/);
  assert.ok(Buffer.byteLength(clipped, 'utf8') < 1600);
  assert.equal(toArray({ agents: [1] }).length, 1);
  assert.equal(toArray({ data: [1, 2] }).length, 2);
  assert.deepEqual(toArray([3]), [3]);
  assert.deepEqual(toArray(null), []);
});

test('中文输入法全角斜杠也能触发命令', async () => {
  const { router } = makeRouter();
  assert.match(await router.handle('／ping', 'me'), /^pong/);
});

test('/list 兼容 {data:[…]} 与 {agents:[…]} 两种管理面响应形状', async () => {
  const mc = { async get() { return { agents: [{ agentId: 'x', status: 'online' }] }; }, async post() { return {}; } };
  const { router } = makeRouter({ mc });
  assert.match(await router.handle('/list', 'me'), /x \[online\]/);
});

test('/status 对不存在的 Agent 给出可读文案', async () => {
  const mc = {
    async get() { const e = new Error('管理面返回 404'); e.status = 404; throw e; },
    async post() { return {}; },
  };
  const { router } = makeRouter({ mc });
  assert.match(await router.handle('/status ghost', 'me'), /未找到 Agent：ghost/);
});

test('/help 覆盖全部命令词（含 confirm 与 help 自身）', async () => {
  const { router } = makeRouter();
  const usage = await router.handle('/help', 'me');
  for (const c of ['/ping', '/list', '/status', '/tasks', '/cost', '/dispatch', '/confirm', '/help']) {
    assert.ok(usage.includes(c), c);
  }
});

test('限流：超速后拒绝并留痕，窗口过后恢复', async () => {
  let t = 0;
  const { router, auditLog, stats } = makeRouter({
    perMinute: 60, burst: 2, confirmStore: undefined,
  });
  // 用注入时钟的限流器重打一次（burst=2）
  const audit2 = [];
  const r2 = createRouter({
    mc: fakeMc(),
    allowFrom: ['me'],
    audit: { record: (e) => audit2.push(e) },
    isoNow: () => 'T',
    rateLimiter: createRateLimiter({ perMinute: 60, burst: 2, now: () => t }),
    stats: createStats({ now: () => t }),
  });
  assert.match(await r2.handle('/ping', 'me'), /^pong/);
  assert.match(await r2.handle('/ping', 'me'), /^pong/);
  const blocked = await r2.handle('/ping', 'me');
  assert.match(blocked, /请求过于频繁/);
  assert.equal(audit2.at(-1).result, 'rate_limited');
  t += 2000; // 60/min = 1/s，2 秒补 2 个令牌
  assert.match(await r2.handle('/ping', 'me'), /^pong/);
  // 默认不限流时高频也放行
  assert.match(await router.handle('/ping', 'me'), /^pong/);
  assert.ok(stats.snapshot().commands >= 1);
});

test('统计：拒绝 / 二次确认 / 错误分别计数', async () => {
  const { router, stats } = makeRouter();
  await router.handle('/ping', 'stranger');            // denied
  await router.handle('/dispatch node-a x', 'me');     // confirm_required
  await router.handle('/list', 'me');                  // ok
  const s = stats.snapshot();
  assert.equal(s.denied, 1);
  assert.equal(s.confirmRequired, 1);
  assert.equal(s.commands, 3);
  assert.equal(s.byCommand['/ping'], 1);
  assert.ok(s.uptimeSec >= 0);
});

test('确认令牌：发起人不一致时不销毁他人令牌', () => {
  let t = 1000;
  const store = createConfirmStore({ ttlMs: 60000, now: () => t });
  const token = store.create({ fromUser: 'me', text: '/dispatch a x' });
  const wrong = store.consume(token, 'you');
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /发起人不一致/);
  const right = store.consume(token, 'me');
  assert.equal(right.ok, true);
  assert.equal(right.command, '/dispatch a x');
  assert.equal(store.size(), 0, '消费后移除');
});

test('确认令牌：过期即清，且 create 时清扫过期项', () => {
  let t = 1000;
  const store = createConfirmStore({ ttlMs: 1000, now: () => t });
  store.create({ fromUser: 'me', text: '/dispatch a x' });
  t += 1001;
  store.create({ fromUser: 'me', text: '/dispatch b y' }); // 触发 prune
  assert.equal(store.size(), 1, '过期令牌被清扫');
});

test('确认令牌：待确认数量有上限（不会无限增长）', () => {
  const store = createConfirmStore({ ttlMs: 60000, now: () => 1000, maxPending: 5 });
  for (let i = 0; i < 20; i++) store.create({ fromUser: 'me', text: '/dispatch a ' + i });
  assert.equal(store.size(), 5);
});

test('审计留痕：confirm 全链路（先 confirm_required 后 ok 且带 confirmed）', async () => {
  const { router, auditLog } = makeRouter();
  const pending = await router.handle('/dispatch node-a 巡检', 'me');
  const token = pending.match(/\/confirm ([0-9A-F]{8})/)[1];
  await router.handle(`/confirm ${token}`, 'me');
  assert.equal(auditLog[0].result, 'confirm_required');
  assert.equal(auditLog[1].result, 'ok');
  assert.equal(auditLog[1].confirmed, '/dispatch node-a 巡检');
});

test('通道标识进入审计（telegram / openclaw / http）', async () => {
  const { router, auditLog } = makeRouter();
  await router.handle('/ping', 'me', { channel: 'telegram' });
  await router.handle('/ping', 'me', { channel: 'openclaw' });
  await router.handle('/ping', 'me');
  assert.deepEqual(auditLog.map((e) => e.channel), ['telegram', 'openclaw', undefined]);
});
