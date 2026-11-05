'use strict';
/**
 * 限流器与计数器的**有界性**回归。
 *
 * 这两处的键都来自不可信输入：限流器的键是发送者 ID / 客户端 IP，
 * 计数器的键是消息首词或请求路径（未命中路由时用完整 path，且发生在鉴权之前）。
 * 只插不删的 Map 会让常驻进程内存无界上涨，而 /statsz 是免鉴权的——
 * 注入的字符串还会被原样读回去。这些用例把上限钉死。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/ratelimit');
const { createStats, MAX_ROUTE_KEYS } = require('../src/stats');

test('限流器：键数量有上限，陌生 ID 再多也不会无界增长', () => {
  const rl = createRateLimiter({ perMinute: 60, burst: 20, maxBuckets: 100, sweepEveryMs: 0 });
  for (let i = 0; i < 5000; i++) rl.check('stranger-' + i);
  assert.ok(rl.size() <= 100, `应被压在 100 以内，实际 ${rl.size()}`);
});

test('限流器：只清「已回满且闲置」的桶，不破坏正在生效的限流', () => {
  let t = 1_000_000;
  const rl = createRateLimiter({
    perMinute: 60, burst: 2, now: () => t, maxBuckets: 10, idleMs: 1000, sweepEveryMs: 0,
  });
  // burst=2，用光 → 桶进入「未回满」状态
  assert.equal(rl.check('a').ok, true);
  assert.equal(rl.check('a').ok, true);
  assert.equal(rl.check('a').ok, false);
  // 时间越过闲置阈值，但只够补回 1.5 个令牌（60/分 = 0.001/ms）
  t += 1500;
  rl.sweep(t);
  assert.equal(rl.size(), 1, '未回满的桶不能被清掉，否则限流白做');
  // 关键是「没被重置成满桶」：1.5 个令牌只够放行一次，满桶（2）能放行两次
  assert.equal(rl.check('a').ok, true, '应按补充后的 1.5 个令牌放行一次');
  assert.equal(rl.check('a').ok, false, '不能被清成满桶——那等于限流白做');
});

test('限流器：回满后闲置的桶会被清掉', () => {
  let t = 1_000_000;
  const rl = createRateLimiter({
    perMinute: 60, burst: 5, now: () => t, maxBuckets: 10, idleMs: 1000, sweepEveryMs: 0,
  });
  rl.check('a');
  t += 5000; // 5 秒后令牌早已回满
  rl.sweep(t);
  assert.equal(rl.size(), 0, '满桶 + 闲置 → 应被清扫');
});

test('限流器：perMinute<=0 时整体关闭且不建桶', () => {
  const rl = createRateLimiter({ perMinute: 0 });
  assert.equal(rl.enabled, false);
  for (let i = 0; i < 100; i++) assert.equal(rl.check('x').ok, true);
  assert.equal(rl.size(), 0);
});

test('计数器：byRoute 键数有上限，超出归并而不是无界增长', () => {
  const st = createStats({ now: () => 1700000000000 });
  for (let i = 0; i < 500; i++) st.request('GET /scan/' + i, 404);
  const snap = st.snapshot();
  assert.ok(Object.keys(snap.byRoute).length <= MAX_ROUTE_KEYS,
    `键数应 <= ${MAX_ROUTE_KEYS}，实际 ${Object.keys(snap.byRoute).length}`);
  assert.ok(snap.routeKeysDropped > 0, '被归并的路径应计数');
  assert.equal(snap.byRoute['*other'] > 0, true);
  // 记账本身不丢：总数与请求数一致
  assert.equal(snap.requests, 500);
  assert.equal(snap.clientErrors, 500);
});

test('计数器：已存在的键继续累加，不会被归并桶抢走', () => {
  const st = createStats({ now: () => 1700000000000 });
  for (let i = 0; i < 200; i++) st.request('GET /api/agents', 200);
  for (let i = 0; i < 500; i++) st.request('GET /junk/' + i, 404);
  const snap = st.snapshot();
  assert.equal(snap.byRoute['GET /api/agents'], 200);
  assert.equal(snap.ok, 200);
});

test('计数器：byStatus 键同样有界（状态码集合虽小，也不靠侥幸）', () => {
  const st = createStats({ now: () => 1700000000000 });
  for (let i = 0; i < 500; i++) st.request('GET /x', 'weird-status-' + i);
  assert.ok(Object.keys(st.snapshot().byStatus).length <= 64);
  assert.equal(st.snapshot().requests, 500);
});
