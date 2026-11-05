'use strict';
/**
 * Mission-Control REST 客户端（零依赖，Node 18+ 全局 fetch）。
 * 所有请求带 Bearer API Key；非 2xx 抛错并带上状态码，供上层转成用户可读文案。
 * 韧性：GET 在网络错误 / 5xx / 408 / 429 时按 attempts 重试（读操作幂等）；
 *       POST 绝不重试——/api/tasks 重试会产生重复任务。
 */
const { createNoopLogger } = require('./log');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function createMcClient({
  base,
  apiKey,
  fetchImpl,
  timeoutMs = 10000,
  attempts = 2,          // 总尝试次数（含首次）；仅对 GET 生效
  retryDelayMs = 250,
  sleepImpl,
  logger = createNoopLogger(),
} = {}) {
  if (!base) throw new Error('MC_BASE 未配置');
  if (!apiKey) throw new Error('MC_API_KEY 未配置');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前 Node 无全局 fetch，请使用 Node 18+ 或注入 fetchImpl');
  }
  const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const root = String(base).replace(/\/+$/, '');
  const maxAttempts = Math.max(1, Number(attempts) || 1);

  async function once(path, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(root + path, {
        method,
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* 保持原文 */ }
      if (!res.ok) {
        const err = new Error('管理面返回 ' + res.status);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(path, method = 'GET', body = null) {
    const canRetry = method === 'GET';
    let lastErr;
    for (let attempt = 1; attempt <= (canRetry ? maxAttempts : 1); attempt++) {
      try {
        return await once(path, method, body);
      } catch (e) {
        lastErr = e;
        const status = e && e.status;
        const retryable = status ? RETRYABLE_STATUS.has(status) : true; // 网络层错误（无 status）可重试
        if (!canRetry || !retryable || attempt === (canRetry ? maxAttempts : 1)) throw e;
        logger.warn('管理面请求失败，重试', { path, attempt, status, error: String(e && e.message || e) });
        await sleep(retryDelayMs * attempt);
      }
    }
    throw lastErr;
  }

  return {
    request,
    get: (path) => request(path, 'GET'),
    post: (path, body) => request(path, 'POST', body),
  };
}

module.exports = { createMcClient, RETRYABLE_STATUS };
