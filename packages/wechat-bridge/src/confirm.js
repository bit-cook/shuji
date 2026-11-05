'use strict';
/**
 * 危险命令二次确认：令牌有效期 60s，仅发起人可确认，一次性消费。
 * 内存存储，重启即失效（有意为之：确认意图不跨重启）。
 * 过期令牌在每次 create 时清扫；待确认数量有上限（先进先出逐出），防内存增长。
 */
const crypto = require('node:crypto');

function createConfirmStore({
  ttlMs = 60000,
  now = () => Date.now(),
  maxPending = 200,
} = {}) {
  const pending = new Map();

  function prune() {
    const t = now();
    for (const [k, rec] of pending) {
      if (t > rec.expiresAt) pending.delete(k);
    }
  }

  function create({ fromUser, text }) {
    prune();
    while (pending.size >= maxPending) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
    const token = crypto.randomBytes(4).toString('hex').toUpperCase();
    pending.set(token, { token, fromUser, text, expiresAt: now() + ttlMs });
    return token;
  }

  function consume(token, fromUser) {
    const key = String(token || '').toUpperCase();
    const rec = pending.get(key);
    if (!rec) return { ok: false, reason: '令牌无效或已使用' };
    // 过期：销毁后拒绝
    if (now() > rec.expiresAt) {
      pending.delete(key);
      return { ok: false, reason: '确认已过期（60 秒）' };
    }
    // 发起人不一致：拒绝但不销毁——别人的误确认不该废掉本人的令牌
    if (rec.fromUser !== fromUser) return { ok: false, reason: '令牌与发起人不一致' };
    pending.delete(key); // 一次性
    return { ok: true, command: rec.text };
  }

  return { create, consume, prune, size: () => pending.size };
}

// 需要二次确认的危险命令（红线：重启、删除、下发任务等）
const DANGEROUS_COMMANDS = new Set(['/dispatch', '/restart', '/delete']);

module.exports = { createConfirmStore, DANGEROUS_COMMANDS };
