'use strict';
/**
 * Telegram Bot API 测试桩：getUpdates 长轮询模拟 + sendMessage 记录。
 * 仅供本地验收（单测/e2e），不是产品代码。
 */
const http = require('node:http');

function createMockTelegram({ failFirstGetUpdates = false } = {}) {
  const state = { queue: [], sent: [], calls: [], getUpdatesCalls: 0, nextId: 1, failed: false };
  const waiters = [];

  function push(update) {
    const u = { update_id: state.nextId++, ...update };
    state.queue.push(u);
    flush();
    return u;
  }
  function flush() {
    while (waiters.length > 0 && state.queue.length > 0) {
      waiters.shift()();
    }
  }

  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const method = url.pathname.split('/').pop();
      const parsed = body ? JSON.parse(body) : {};
      state.calls.push({ method, body: parsed });
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (method === 'getMe') {
        json(200, { ok: false, error_code: 429, description: 'Too Many Requests' });
        return;
      }
      if (method === 'getUpdates') {
        state.getUpdatesCalls++;
        if (failFirstGetUpdates && !state.failed) {
          state.failed = true;
          json(200, { ok: false, error_code: 429, description: 'Too Many Requests' });
          return;
        }
        const offset = parsed.offset || 0;
        const ready = state.queue.filter((u) => u.update_id >= offset);
        if (ready.length > 0) {
          state.queue = state.queue.filter((u) => u.update_id < offset);
          json(200, { ok: true, result: ready });
          return;
        }
        // 模拟长轮询：等新消息或最多 400ms
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: state.queue.filter((u) => u.update_id >= offset) }));
          state.queue = state.queue.filter((u) => u.update_id < offset);
        }, 400);
        const waiter = () => {
          clearTimeout(timer);
          const after = state.queue.filter((u) => u.update_id >= offset);
          state.queue = state.queue.filter((u) => u.update_id < offset);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: after }));
        };
        waiters.push(waiter);
        return;
      }
      if (method === 'sendMessage') {
        state.sent.push(parsed);
        json(200, { ok: true, result: { message_id: state.sent.length, ...parsed } });
        return;
      }
      json(404, { ok: false, description: 'not found' });
    });
  };

  const server = http.createServer(handler);
  return {
    state,
    push,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(r);
    }),
  };
}

module.exports = { createMockTelegram };
