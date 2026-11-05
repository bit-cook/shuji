'use strict';
/**
 * Mission-Control REST 客户端（零依赖，Node 18+ 全局 fetch）。
 * 所有请求带 Bearer API Key；非 2xx 抛错并带上状态码，供上层转成用户可读文案。
 */

function createMcClient({ base, apiKey, fetchImpl, timeoutMs = 10000 } = {}) {
  if (!base) throw new Error('MC_BASE 未配置');
  if (!apiKey) throw new Error('MC_API_KEY 未配置');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前 Node 无全局 fetch，请使用 Node 18+ 或注入 fetchImpl');
  }
  const root = String(base).replace(/\/+$/, '');

  async function request(path, method = 'GET', body = null) {
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

  return {
    request,
    get: (path) => request(path, 'GET'),
    post: (path, body) => request(path, 'POST', body),
  };
}

module.exports = { createMcClient };
