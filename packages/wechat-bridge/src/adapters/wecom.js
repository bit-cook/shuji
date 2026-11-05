'use strict';
/**
 * 企业微信自建应用适配器：回调验签加解密 + 被动回复 + 主动发送。
 * 零第三方依赖：crypto 模块实现官方 WXBizMsgCrypt 等价逻辑，XML 用最小解析。
 * 规范见企业微信官方文档「接收消息与回复」加解密方案。
 *
 * 加固（红线配套）：
 *   - msg_signature 验签先于解密；验签失败一律 400（伪造签名摸不到命令核心）
 *   - timestamp 时间窗校验（默认 ±300s，0 关闭）：挡旧回调重放
 *   - XML 实体反转义：命令里的 & < > 不再被吃掉
 *   - 解密后内容长度边界校验，畸形密文不会读出越界缓冲区
 */
const crypto = require('node:crypto');
const http = require('node:http');
const { createNoopLogger } = require('../log');

// ---------- 基础编解码 ----------

function aesKeyFrom(encodingAesKey) {
  const key = Buffer.from(String(encodingAesKey) + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 长度非法（应为 43 字符）');
  return key;
}

function pkcs7Pad(buf, blockSize = 32) {
  const pad = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32 || pad > buf.length) throw new Error('PKCS#7 填充非法');
  return buf.subarray(0, buf.length - pad);
}

function signature({ token, timestamp, nonce, encrypt }) {
  const sha1 = crypto.createHash('sha1');
  // 官方规范：将 token、timestamp、nonce、encrypt 四个参数按字典序拼接后 sha1
  const sorted = [token, String(timestamp), nonce, encrypt].sort();
  return sha1.update(sorted.join(''), 'utf8').digest('hex');
}

function encryptMsg({ aesKey, corpId, text }) {
  const random = crypto.randomBytes(16);
  const content = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(content.length, 0);
  const appId = Buffer.from(corpId, 'utf8');
  const raw = Buffer.concat([random, len, content, appId]);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false); // 填充由上面的 pkcs7Pad 负责，避免双重填充
  const enc = Buffer.concat([cipher.update(pkcs7Pad(raw)), cipher.final()]);
  return Buffer.concat([iv, enc]).toString('base64');
}

function decryptMsg({ aesKey, corpId, base64 }) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 32 || (buf.length - 16) % 16 !== 0) throw new Error('密文长度非法');
  const iv = buf.subarray(0, 16);
  const body = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false); // 解填充由下面的 pkcs7Unpad 负责
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  const raw = pkcs7Unpad(plain);
  if (raw.length < 20) throw new Error('明文长度非法');
  const contentLen = raw.readUInt32BE(16);
  if (contentLen < 0 || 20 + contentLen > raw.length) throw new Error('密文内容长度非法');
  const content = raw.subarray(20, 20 + contentLen).toString('utf8');
  const appId = raw.subarray(20 + contentLen).toString('utf8');
  if (corpId && appId !== corpId) throw new Error('AppID 不匹配');
  return content;
}

// ---------- 最小 XML ----------

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

/** 反转义 XML 实体（含 &#xHH; / &#DD; 数字实体），让命令原文可用。 */
function unescapeXml(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;|&gt;|&amp;|&quot;|&apos;/g, (m) => ENTITIES[m]);
}

function extractTag(xml, tag) {
  const cdata = new RegExp('<' + tag + '>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</' + tag + '>');
  const plain = new RegExp('<' + tag + '>([^<]*)</' + tag + '>');
  const m = xml.match(cdata) || xml.match(plain);
  return m ? unescapeXml(m[1]) : null;
}

function buildReplyXml({ encrypt, msgSignature, timestamp, nonce }) {
  return '<xml><Encrypt><![CDATA[' + encrypt + ']]></Encrypt>' +
    '<MsgSignature><![CDATA[' + msgSignature + ']]></MsgSignature>' +
    '<TimeStamp>' + timestamp + '</TimeStamp>' +
    '<Nonce><![CDATA[' + nonce + ']]></Nonce></xml>';
}

// ---------- 适配器 ----------

function createWecomAdapter({
  token, encodingAesKey, corpId, router,
  path = '/callback',
  timestampWindowSec = 300,      // 回调时间窗；0 = 不校验（不推荐）
  nowSec = () => Math.floor(Date.now() / 1000),
  logger = createNoopLogger(),
  onError = (e) => process.stderr.write('wecom adapter error: ' + (e && e.stack || e) + '\n'),
} = {}) {
  const aesKey = aesKeyFrom(encodingAesKey);
  if (aesKey.length !== 32) throw new Error('EncodingAESKey 长度非法（应为 43 字符）');
  const log = logger.child ? logger.child({ mod: 'wecom' }) : logger;

  /** 时间窗校验：拒绝过期回调（重放防护）。 */
  function checkFreshness(timestamp) {
    if (!timestampWindowSec || Number(timestampWindowSec) <= 0) return;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) throw new Error('timestamp 非法');
    if (Math.abs(nowSec() - ts) > Number(timestampWindowSec)) throw new Error('回调时间戳超出时间窗');
  }

  function verifyUrl(query) {
    const { msg_signature: sig, timestamp, nonce, echostr } = query;
    checkFreshness(timestamp);
    if (signature({ token, timestamp, nonce, encrypt: echostr }) !== sig) {
      throw new Error('URL 验签失败');
    }
    return decryptMsg({ aesKey, corpId, base64: echostr });
  }

  async function handleMessage(bodyXml, query) {
    const { msg_signature: sig, timestamp, nonce } = query;
    const encrypt = extractTag(bodyXml, 'Encrypt');
    if (!encrypt) throw new Error('消息体缺少 Encrypt');
    checkFreshness(timestamp);
    if (signature({ token, timestamp, nonce, encrypt }) !== sig) {
      throw new Error('消息验签失败');
    }
    const inner = decryptMsg({ aesKey, corpId, base64: encrypt });
    const content = extractTag(inner, 'Content');
    const fromUser = extractTag(inner, 'FromUserName');
    const msgType = extractTag(inner, 'MsgType');
    if (msgType !== 'text' || content == null) return null; // 非文本暂不处理
    const replyText = await router.handle(content, fromUser, { channel: 'wecom' });

    const ts = String(nowSec());
    const nonce2 = crypto.randomBytes(8).toString('hex');
    const enc = encryptMsg({ aesKey, corpId, text: replyText });
    const msgSig = signature({ token, timestamp: ts, nonce: nonce2, encrypt: enc });
    return buildReplyXml({ encrypt: enc, msgSignature: msgSig, timestamp: ts, nonce: nonce2 });
  }

  /** 超大请求体：先写 413 再断链，客户端才读得到（直接 destroy 只会看到连接重置）。 */
  function rejectTooLarge(req, res) {
    if (res.writableEnded) return;
    try {
      req.pause();
      res.writeHead(413, { 'Content-Type': 'text/plain', 'Connection': 'close' });
      res.end('payload too large');
    } catch { /* 连接已断开 */ }
  }

  // 返回 http 请求处理器；也可被其他服务器直接调用 handle(req,res)
  function handler(req, res) {
    req.on('error', (e) => log.warn('请求错误', { error: String(e && e.message || e) }));
    res.on('error', (e) => log.warn('响应错误', { error: String(e && e.message || e) }));

    let url;
    try { url = new URL(req.url, 'http://x'); } catch {
      try { res.writeHead(400); res.end(); } catch { /* 忽略 */ }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      try { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); } catch { /* 忽略 */ }
      return;
    }
    if (url.pathname !== path) {
      try { res.writeHead(404); res.end(); } catch { /* 忽略 */ }
      return;
    }
    const query = Object.fromEntries(url.searchParams);
    const send = (code, body, ctype) => {
      if (res.writableEnded) return;
      try {
        res.writeHead(code, { 'Content-Type': ctype || 'text/plain' });
        res.end(body);
      } catch { /* 连接已断开 */ }
    };
    if (req.method === 'GET') {
      try { send(200, verifyUrl(query)); }
      catch (e) { onError(e); send(400, 'verify failed'); }
      return;
    }
    if (req.method === 'POST') {
      // 声明式超限直接拒；分块上传在 data 里兜底
      if (Number(req.headers['content-length'] || 0) > 1e6) { rejectTooLarge(req, res); return; }
      // 按 Buffer 收集，读完一次性解码。逐块 `body += c` 会把多字节 UTF-8 字符
      // （中文 1 字 3 字节）在 TCP 分块边界上切成两半各自解码，各自变成 U+FFFD。
      const chunks = [];
      let received = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        if (tooLarge) return;
        received += c.length;
        if (received > 1e6) {
          tooLarge = true;
          chunks.length = 0;
          rejectTooLarge(req, res);
          return;
        }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (res.writableEnded || tooLarge) return;
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const reply = await handleMessage(body, query);
          if (reply === null) { send(200, ''); return; } // 非文本：回复空串即可
          send(200, reply, 'application/xml');
        } catch (e) { onError(e); send(400, 'bad request'); }
      });
      return;
    }
    send(405, 'method not allowed');
  }

  return { handler, verifyUrl, handleMessage, signature, encryptMsg, decryptMsg, aesKey, checkFreshness };
}

// ---------- 主动发送（告警/回报用） ----------

function createWecomNotifier({
  corpId, agentId, secret,
  fetchImpl,
  now = () => Date.now(),
  apiBase = 'https://qyapi.weixin.qq.com',
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let tokenCache = { value: null, expiresAt: 0 };

  async function getAccessToken() {
    if (tokenCache.value && now() < tokenCache.expiresAt) return tokenCache.value;
    const res = await doFetch(
      apiBase + '/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpId) +
      '&corpsecret=' + encodeURIComponent(secret));
    const data = await res.json();
    if (!data.access_token) throw new Error('gettoken 失败：' + JSON.stringify(data));
    const ttlSec = Number(data.expires_in) > 600 ? Number(data.expires_in) : 7200;
    tokenCache = { value: data.access_token, expiresAt: now() + (ttlSec - 300) * 1000 };
    return tokenCache.value;
  }

  async function sendText(toUser, content) {
    const token = await getAccessToken();
    const res = await doFetch(
      apiBase + '/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: toUser, msgtype: 'text', agentid: Number(agentId),
          text: { content },
        }),
      });
    const data = await res.json();
    if (data.errcode !== 0) throw new Error('发送失败 errcode=' + data.errcode + ' ' + (data.errmsg || ''));
    return data;
  }

  return { getAccessToken, sendText };
}

function listen({ handler, port = 8080, host = '127.0.0.1', onListen, onError } = {}) {
  const server = http.createServer(handler);
  server.on('error', (e) => {
    if (onError) onError(e);
    else process.stderr.write('server error: ' + (e && e.message || e) + '\n');
  });
  server.on('clientError', (err, socket) => {
    if (err && err.code === 'ECONNRESET') return; // 客户端主动断开，无需 400
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 忽略 */ }
  });
  server.listen(port, host, () => onListen && onListen(server.address()));
  return server;
}

module.exports = {
  createWecomAdapter, createWecomNotifier, listen,
  signature, encryptMsg, decryptMsg, aesKeyFrom, buildReplyXml, extractTag, unescapeXml,
  pkcs7Pad, pkcs7Unpad,
};
