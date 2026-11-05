'use strict';
/**
 * 通用 HTTP 适配器：给测试、其他平台（飞书/钉钉/TG 风格 webhook）或人工排查用。
 * POST {path}  body: {"from": "<userId>", "text": "/list"}  → {"reply": "..."}
 * GET /healthz → ok      GET /statsz → 计数快照 JSON
 *
 * 安全（红线）：
 *   - token 配置后，所有消息端点强制 Bearer 鉴权（OpenClaw 插件的 cardinalToken 因此真正生效）
 *   - 请求体上限 1MB，超限回 413 并断开，不做无界缓冲
 *   - req/res 的 error 事件全部接管，坏连接不会打崩进程
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { createNoopLogger } = require('../log');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function createHttpAdapter({
  router,
  paths = ['/message', '/openclaw'],
  token,                       // 配置后强制 Bearer 鉴权
  stats,                       // 可选：计数器快照经 /statsz 暴露
  maxBodyBytes = 1e6,
  logger = createNoopLogger(),
} = {}) {
  const pathSet = new Set(paths);
  const log = logger.child ? logger.child({ mod: 'http' }) : logger;
  const CHANNEL_BY_PATH = { '/openclaw': 'openclaw' };

  function sendJson(res, code, obj) {
    if (res.writableEnded) return;
    try {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch (e) { log.warn('响应写失败', { error: String(e && e.message || e) }); }
  }

  function authorized(req) {
    if (!token) return true;
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    try { return safeEqual(m[1].trim(), token); } catch { return false; }
  }

  /**
   * 超大请求体：回 413 并断链。必须先写响应再断，客户端才读得到 413
   * （直接 destroy 只会看到连接被重置）。Connection: close 让 Node 收尾后自然关闭。
   */
  function rejectTooLarge(req, res) {
    if (res.writableEnded) return;
    try {
      req.pause();
      res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: 'payload too large' }));
    } catch (e) { log.warn('413 响应写失败', { error: String(e && e.message || e) }); }
  }

  function handler(req, res) {
    req.on('error', (e) => log.warn('请求错误', { error: String(e && e.message || e) }));
    res.on('error', (e) => log.warn('响应错误', { error: String(e && e.message || e) }));

    let url;
    try { url = new URL(req.url, 'http://x'); } catch { sendJson(res, 400, { error: 'bad url' }); return; }
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      try { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); } catch { /* 忽略 */ }
      return;
    }
    if (req.method === 'GET' && pathname === '/statsz') {
      sendJson(res, 200, stats ? stats.snapshot() : {});
      return;
    }

    if (req.method === 'POST' && pathSet.has(pathname)) {
      if (!authorized(req)) {
        log.warn('未授权请求被拒', { path: pathname });
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      // 声明式超限（带 Content-Length 的常见请求）直接拒，免得多读一个字节
      if (Number(req.headers['content-length'] || 0) > maxBodyBytes) {
        rejectTooLarge(req, res);
        return;
      }
      // 按 Buffer 收集，读完一次性解码。逐块 `body += c` 会把每块各自 toString：
      // 多字节 UTF-8 字符（中文 1 字 3 字节）恰好被 TCP 分块切开时，两半各自解码
      // 都变成 U+FFFD。U+FFFD 出现在字符串值内部，JSON.parse 照样成功——命令
      // 原文被静默换掉，坏在数据里，报错却一个都没有，更难察觉。字节上限口径在此统一。
      const chunks = [];
      let received = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        if (tooLarge) return;
        received += c.length;
        if (received > maxBodyBytes) {
          tooLarge = true;
          chunks.length = 0;
          rejectTooLarge(req, res);
          return;
        }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (res.writableEnded || tooLarge) return;
        let msg;
        try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { sendJson(res, 400, { error: 'invalid json' }); return; }
        try {
          const reply = await router.handle(
            msg.text,
            msg.from == null ? '' : msg.from,
            { channel: CHANNEL_BY_PATH[pathname] || 'http' },
          );
          sendJson(res, 200, { reply });
        } catch (e) {
          log.error('命令处理异常', { error: String(e && e.message || e) });
          sendJson(res, 500, { error: 'internal error' });
        }
      });
      return;
    }

    try { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); } catch { /* 忽略 */ }
  }

  return { handler };
}

module.exports = { createHttpAdapter };
