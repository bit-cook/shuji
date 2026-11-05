'use strict';
/**
 * 令牌桶限流（按发送者维度）：防插件重试风暴 / 通道故障刷屏打爆控制面。
 * 默认 60 条/分、突发 20 条；perMinute<=0 表示关闭。
 * 纯内存、重启清零；被限流的消息同样进审计（result=rate_limited）。
 *
 * 桶的键是**调用方给的任意字符串**（桥侧是发送者 ID，控制面侧是客户端 IP），
 * 两者都能被陌生人影响。Map 只插不删的话，一个半夜扫进来的陌生 ID 就能让
 * 常驻进程的内存缓慢无界上涨——所以这里带闲置清扫与硬上限。
 *
 * 清扫策略的关键：只丢「已回满且闲置」的桶。满桶重建出来还是一满桶，
 * 丢掉它不改变任何限流结果；而正在被限流的桶（tokens < cap）不能随便丢，
 * 否则限流白做。
 */
function createRateLimiter({
  perMinute = 60,
  burst = 20,
  now = () => Date.now(),
  maxBuckets = 4096,
  idleMs = 10 * 60 * 1000,
  sweepEveryMs = 60 * 1000,
} = {}) {
  const enabled = Number(perMinute) > 0;
  const rate = enabled ? Number(perMinute) / 60000 : 0; // token/ms
  const cap = Math.max(1, Number(burst) || 1);
  const buckets = new Map();
  let lastSweep = now();

  /** 清扫闲置满桶；返回删掉的条数。保证返回后 size < maxBuckets（留出插入名额）。 */
  function sweep(t = now()) {
    lastSweep = t;
    if (buckets.size === 0) return 0;
    let removed = 0;
    // 1) 丢「现已回满且闲置」的桶：满桶重建出来还是一满桶，丢掉不改变任何限流结果。
    //    注意这里要自己算补充量——桶的 tokens 只在 check() 里刷新，闲置已久的桶
    //    记录的是消耗后的旧值，直接比 cap 会把它误判成「还在限流中」而永远清不掉。
    for (const [k, b] of buckets) {
      const wouldBe = Math.min(cap, b.tokens + (t - b.ts) * rate);
      if (wouldBe >= cap && t - b.ts > idleMs) { buckets.delete(k); removed += 1; }
    }
    // 2) 硬上限：先丢满桶（安全），丢完还超就按插入序丢最老的。
    //    丢一个正在限流的桶等于给它一次免费重试，但相比内存无界增长这是必要的取舍。
    if (buckets.size >= maxBuckets) {
      for (const [k, b] of [...buckets]) {
        if (buckets.size < maxBuckets) break;
        const wouldBe = Math.min(cap, b.tokens + (t - b.ts) * rate);
        if (wouldBe >= cap) { buckets.delete(k); removed += 1; }
      }
      while (buckets.size >= maxBuckets) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest); removed += 1;
      }
    }
    return removed;
  }

  /** 取 1 个令牌；返回 { ok, retryAfterMs, remaining } */
  function check(key, cost = 1) {
    if (!enabled) return { ok: true, remaining: Infinity };
    const k = String(key ?? '');
    const t = now();
    if (t - lastSweep >= sweepEveryMs) sweep(t);
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

  return { check, enabled, sweep, size: () => buckets.size, reset: () => buckets.clear() };
}

module.exports = { createRateLimiter };
