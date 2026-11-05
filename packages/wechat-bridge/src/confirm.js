'use strict';
/**
 * 危险命令二次确认：令牌有效期 60s，仅发起人可确认，一次性消费。
 * 内存存储，重启即失效（有意为之：确认意图不跨重启）。
 */
const crypto = require('node:crypto');

function createConfirmStore({ ttlMs = 60000, now = () => Date.now() } = {}) {
  const pending = new Map();

  function create({ fromUser, text }) {
    const token = crypto.randomBytes(4).toString('hex').toUpperCase();
    pending.set(token, { token, fromUser, text, expiresAt: now() + ttlMs });
    return token;
  }

  function consume(token, fromUser) {
    const key = String(token || '').toUpperCase();
    const rec = pending.get(key);
    if (!rec) return { ok: false, reason: '令牌无效或已使用' };
    pending.delete(key);
    if (rec.fromUser !== fromUser) return { ok: false, reason: '令牌与发起人不一致' };
    if (now() > rec.expiresAt) return { ok: false, reason: '确认已过期（60 秒）' };
    return { ok: true, command: rec.text };
  }

  return { create, consume, size: () => pending.size };
}

// 需要二次确认的危险命令（红线：重启、删除、下发任务等）
const DANGEROUS_COMMANDS = new Set(['/dispatch', '/restart', '/delete']);

module.exports = { createConfirmStore, DANGEROUS_COMMANDS };
