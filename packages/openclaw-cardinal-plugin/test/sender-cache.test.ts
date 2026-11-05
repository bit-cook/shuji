import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSenderCache,
  resolveSender,
  senderFromPrefix,
  type SenderRecord,
} from '../src/sender-cache.ts';

function rec(senderId: string, at = 1000): SenderRecord {
  return { senderId, from: senderId, at };
}

test('缓存按 sessionKey 存取', () => {
  const c = createSenderCache({ now: () => 1000 });
  c.set('s1', rec('wx-user-1'));
  assert.equal(c.get('s1')?.senderId, 'wx-user-1');
  assert.equal(c.get('missing'), null);
  assert.equal(c.size(), 1);
});

test('缓存过期后取不到', () => {
  let t = 1000;
  const c = createSenderCache({ ttlMs: 5000, now: () => t });
  c.set('s1', rec('u1'));
  t += 4999;
  assert.ok(c.get('s1'));
  t += 2;
  assert.equal(c.get('s1'), null);
});

test('缓存容量有上限（不会随会话数无限增长）', () => {
  let t = 0;
  const c = createSenderCache({ max: 3, ttlMs: 10 ** 9, now: () => ++t });
  for (let i = 0; i < 10; i++) c.set('s' + i, rec('u' + i));
  assert.equal(c.size(), 3);
});

test('空 key 不入缓存', () => {
  const c = createSenderCache({ now: () => 1 });
  c.set('', rec('u'));
  assert.equal(c.size(), 0);
});

test('senderFromPrefix：通道前缀里取身份标识', () => {
  assert.equal(senderFromPrefix('[微信 · DM] wxid_abc123:'), 'wxid_abc123');
  assert.equal(senderFromPrefix('Telegram 42: /list'), '42');
  assert.equal(senderFromPrefix('/ping'), null); // 无前缀
  assert.equal(senderFromPrefix('帮我看一下今天的安排'), null); // 无冒号
  assert.equal(senderFromPrefix(`备注 ${'x'.repeat(80)}: /list`), null); // 前缀过长
});

test('resolveSender：缓存优先，前缀兜底，都没有则空串（fail-closed）', () => {
  assert.equal(resolveSender(rec('wx-1'), ' Telegram 42: /list'), 'wx-1');
  assert.equal(resolveSender(null, 'Telegram 42: /list'), '42');
  assert.equal(resolveSender(null, '/list'), '');
  assert.equal(resolveSender(null, '随便说点啥'), '');
});
