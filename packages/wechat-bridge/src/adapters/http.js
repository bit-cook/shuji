'use strict';
/**
 * 通用 HTTP 适配器：给测试、其他平台（飞书/钉钉/TG 风格 webhook）或人工排查用。
 * POST {path}  body: {"from": "<userId>", "text": "/list"}  → {"reply": "..."}
 * GET /healthz → ok
 */
const http = require('node:http');

function createHttpAdapter({ router, path = '/message' }) {
  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && url.pathname === path) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid json"}'); return; }
        const reply = await router.handle(msg.text, msg.from);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
  return { handler };
}

module.exports = { createHttpAdapter };
