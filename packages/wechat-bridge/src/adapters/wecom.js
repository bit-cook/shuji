'use strict';
/**
 * 企业微信自建应用适配器：回调验签加解密 + 被动回复 + 主动发送。
 * 零第三方依赖：crypto 模块实现官方 WXBizMsgCrypt 等价逻辑，XML 用最小解析。
 * 规范见企业微信官方文档「接收消息与回复」加解密方案。
 */
const crypto = require('node:crypto');
const http = require('node:http');

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
  return crypto.createHash('sha1').update(sorted.join(''), 'utf8').digest('hex');
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
  const content = raw.subarray(20, 20 + contentLen).toString('utf8');
  const appId = raw.subarray(20 + contentLen).toString('utf8');
  if (corpId && appId !== corpId) throw new Error('AppID 不匹配');
  return content;
}

// ---------- 最小 XML ----------

function extractTag(xml, tag) {
  const cdata = new RegExp('<' + tag + '>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</' + tag + '>');
  const plain = new RegExp('<' + tag + '>([^<]*)</' + tag + '>');
  const m = xml.match(cdata) || xml.match(plain);
  return m ? m[1] : null;
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
  nowSec = () => Math.floor(Date.now() / 1000),
  onError = (e) => process.stderr.write('wecom adapter error: ' + (e && e.stack || e) + '\n'),
}) {
  const aesKey = aesKeyFrom(encodingAesKey);
  if (aesKey.length !== 32) throw new Error('EncodingAESKey 长度非法（应为 43 字符）');

  function verifyUrl(query) {
    const { msg_signature: sig, timestamp, nonce, echostr } = query;
    if (signature({ token, timestamp, nonce, encrypt: echostr }) !== sig) {
      throw new Error('URL 验签失败');
    }
    return decryptMsg({ aesKey, corpId, base64: echostr });
  }

  async function handleMessage(bodyXml, query) {
    const { msg_signature: sig, timestamp, nonce } = query;
    const encrypt = extractTag(bodyXml, 'Encrypt');
    if (!encrypt) throw new Error('消息体缺少 Encrypt');
    if (signature({ token, timestamp, nonce, encrypt }) !== sig) {
      throw new Error('消息验签失败');
    }
    const inner = decryptMsg({ aesKey, corpId, base64: encrypt });
    const content = extractTag(inner, 'Content');
    const fromUser = extractTag(inner, 'FromUserName');
    const msgType = extractTag(inner, 'MsgType');
    if (msgType !== 'text' || content == null) return null; // 非文本暂不处理
    const replyText = await router.handle(content, fromUser);

    const ts = String(nowSec());
    const nonce2 = crypto.randomBytes(8).toString('hex');
    const enc = encryptMsg({ aesKey, corpId, text: replyText });
    const msgSig = signature({ token, timestamp: ts, nonce: nonce2, encrypt: enc });
    return buildReplyXml({ encrypt: enc, msgSignature: msgSig, timestamp: ts, nonce: nonce2 });
  }

  // 返回 http 请求处理器；也可被其他服务器直接调用 handle(req,res)
  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== path) { res.writeHead(404); res.end(); return; }
    const query = Object.fromEntries(url.searchParams);
    const send = (code, body, ctype) => {
      res.writeHead(code, { 'Content-Type': ctype || 'text/plain' });
      res.end(body);
    };
    if (req.method === 'GET') {
      try { send(200, verifyUrl(query)); }
      catch (e) { onError(e); send(400, 'verify failed'); }
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
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

  return { handler, verifyUrl, handleMessage, signature, encryptMsg, decryptMsg, aesKey };
}

// ---------- 主动发送（告警/回报用） ----------

function createWecomNotifier({ corpId, agentId, secret, fetchImpl, now = () => Date.now() }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let tokenCache = { value: null, expiresAt: 0 };

  async function getAccessToken() {
    if (tokenCache.value && now() < tokenCache.expiresAt) return tokenCache.value;
    const res = await doFetch(
      'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpId) +
      '&corpsecret=' + encodeURIComponent(secret));
    const data = await res.json();
    if (!data.access_token) throw new Error('gettoken 失败：' + JSON.stringify(data));
    tokenCache = { value: data.access_token, expiresAt: now() + (data.expires_in - 300) * 1000 };
    return tokenCache.value;
  }

  async function sendText(toUser, content) {
    const token = await getAccessToken();
    const res = await doFetch(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
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

function listen({ handler, port = 8080, host = '127.0.0.1', onListen } = {}) {
  const server = http.createServer(handler);
  server.listen(port, host, () => onListen && onListen(server.address()));
  return server;
}

module.exports = {
  createWecomAdapter, createWecomNotifier, listen,
  signature, encryptMsg, decryptMsg, aesKeyFrom, buildReplyXml, extractTag, pkcs7Pad, pkcs7Unpad,
};
