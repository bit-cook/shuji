'use strict';
/**
 * 令牌桶限流（按发送者维度）：防插件重试风暴 / 通道故障刷屏打爆控制面。
 * 默认 60 条/分、突发 20 条；perMinute<=0 表示关闭。
 * 纯内存、重启清零；被限流的消息同样进审计（result=rate_limited）。
 */
function createRateLimiter({
  perMinute = 60,
  burst = 20,
  now = () => Date.now(),
} = {}) {
  const enabled = Number(perMinute) > 0;
  const rate = enabled ? Number(perMinute) / 60000 : 0; // token/ms
  const cap = Math.max(1, Number(burst) || 1);
  const buckets = new Map();

  /** 取 1 个令牌；返回 { ok, retryAfterMs, remaining } */
  function check(key, cost = 1) {
    if (!enabled) return { ok: true, remaining: Infinity };
    const k = String(key ?? '');
    const t = now();
    let b = buckets.get(k);
    if (!b) {
      b = { tokens: cap, ts: t };
      buckets.set(k, b);
    } else {
      // 按时间间隔补充令牌，上限为突发容量
      b.tokens = Math.min(cap, b.tokens + (t - b.ts) * rate);
      b.ts = t;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    return { ok: false, retryAfterMs: Math.ceil((cost - b.tokens) / rate), remaining: 0 };
  }

  return { check, enabled, size: () => buckets.size, reset: () => buckets.clear() };
}

module.exports = { createRateLimiter };
