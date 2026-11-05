'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const w = require('../src/adapters/wecom');
const { createRouter } = require('../src/core');

const TOKEN = 'QDG6eK';
const CORP = 'wwabc123corp';
const AES = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 字符
const aesKey = w.aesKeyFrom(AES);

function fakeMc() {
  return {
    async get(p) {
      if (p === '/api/agents') return [{ agentId: 'node-a', status: 'online', model: 'm1' }];
      throw new Error('404');
    },
    async post() { return { ok: true }; },
  };
}

test('EncodingAESKey 解析为 32 字节', () => {
  assert.equal(aesKey.length, 32);
  assert.throws(() => w.aesKeyFrom('tooshort'), /长度非法|Base64|缓冲/);
});

test('签名按字典序拼接 sha1', () => {
  const s = w.signature({ token: TOKEN, timestamp: '1409304348', nonce: 'xxxxxx', encrypt: 'pram' });
  // 与官方文档示例一致的算法（自行复算验证稳定性）
  const manual = require('node:crypto').createHash('sha1')
    .update(['QDG6eK', '1409304348', 'xxxxxx', 'pram'].sort().join('')).digest('hex');
  assert.equal(s, manual);
  assert.equal(s.length, 40);
});

test('加解密往返一致且校验 AppID', () => {
  const enc = w.encryptMsg({ aesKey, corpId: CORP, text: '你好 /list' });
  assert.equal(typeof enc, 'string');
  assert.equal(w.decryptMsg({ aesKey, corpId: CORP, base64: enc }), '你好 /list');
  // 错误 AppID 必须拒绝
  assert.throws(() => w.decryptMsg({ aesKey, corpId: 'other', base64: enc }), /AppID/);
  // 篡改必须拒绝：截断 / 末块翻转（打乱填充或 AppID）
  const tampered = Buffer.from(enc, 'base64');
  assert.throws(() => w.decryptMsg({ aesKey, corpId: CORP, base64: tampered.subarray(0, 40).toString('base64') }), /长度非法/);
  const lastFlip = Buffer.from(enc, 'base64');
  lastFlip[lastFlip.length - 1] ^= 0x01;
  assert.throws(() => w.decryptMsg({ aesKey, corpId: CORP, base64: lastFlip.toString('base64') }));
  // 注：CBC 下单字节翻转只会损坏对应明文块（内容级 malleability），
  // 防篡改靠 adapter 层对 Encrypt  blob 的 msg_signature 验签，见回调测试。
});

test('GET 回调 URL 验证：解出 echostr', () => {
  const echostr = w.encryptMsg({ aesKey, corpId: CORP, text: 'hello-verify' });
  const ts = '1700000000', nonce = 'n1';
  const adapter = w.createWecomAdapter({
    token: TOKEN, encodingAesKey: AES, corpId: CORP, router: { handle: async () => 'x' },
  });
  assert.equal(adapter.verifyUrl({
    msg_signature: w.signature({ token: TOKEN, timestamp: ts, nonce, encrypt: echostr }),
    timestamp: ts, nonce, echostr,
  }), 'hello-verify');
  assert.throws(() => adapter.verifyUrl({
    msg_signature: 'bad', timestamp: ts, nonce, echostr,
  }), /验签失败/);
});

function inboundXml(inner, token, ts, nonce) {
  const enc = w.encryptMsg({ aesKey, corpId: CORP, text: inner });
  const body = '<xml><ToUserName><![CDATA[' + CORP + ']]></ToUserName>' +
    '<Encrypt><![CDATA[' + enc + ']]></Encrypt>' +
    '<AgentID><![CDATA[1000002]]></AgentID></xml>';
  return { body, enc, sig: w.signature({ token, timestamp: ts, nonce, encrypt: enc }) };
}

test('完整回调：加密文本消息进 → 加密回复出（真服务器）', async () => {
  const router = createRouter({
    mc: fakeMc(), allowFrom: ['me'], audit: { record() {} },
    isoNow: () => '2026-01-01T00:00:00.000Z',
  });
  const adapter = w.createWecomAdapter({ token: TOKEN, encodingAesKey: AES, corpId: CORP, router });
  const server = http.createServer(adapter.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // /ping
  {
    const ts = '1700000001', nonce = 'nA';
    const inner = '<xml><ToUserName><![CDATA[' + CORP + ']]></ToUserName><FromUserName><![CDATA[me]]></FromUserName>' +
      '<CreateTime>1700000001</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/ping]]></Content>' +
      '<MsgId>1</MsgId><AgentID>1000002</AgentID></xml>';
    const { body, sig } = inboundXml(inner, TOKEN, ts, nonce);
    const res = await fetch(`http://127.0.0.1:${port}/callback?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
      method: 'POST', headers: { 'Content-Type': 'application/xml' }, body,
    });
    assert.equal(res.status, 200);
    const xml = await res.text();
    const enc = w.extractTag(xml, 'Encrypt');
    const replySig = w.extractTag(xml, 'MsgSignature');
    const ts2 = w.extractTag(xml, 'TimeStamp');
    const nonce2 = w.extractTag(xml, 'Nonce');
    assert.equal(replySig, w.signature({ token: TOKEN, timestamp: ts2, nonce: nonce2, encrypt: enc }));
    assert.equal(w.decryptMsg({ aesKey, corpId: CORP, base64: enc }), 'pong · 2026-01-01T00:00:00.000Z');
  }

  // 非白名单用户
  {
    const ts = '1700000002', nonce = 'nB';
    const inner = '<xml><FromUserName><![CDATA[stranger]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/list]]></Content></xml>';
    const { body, sig } = inboundXml(inner, TOKEN, ts, nonce);
    const res = await fetch(`http://127.0.0.1:${port}/callback?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
      method: 'POST', body,
    });
    const enc = w.extractTag(await res.text(), 'Encrypt');
    assert.equal(w.decryptMsg({ aesKey, corpId: CORP, base64: enc }), '拒绝访问：不在白名单内');
  }

  // 验签失败的消息必须 400
  {
    const ts = '1700000003', nonce = 'nC';
    const inner = '<xml><FromUserName><![CDATA[me]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/ping]]></Content></xml>';
    const { body } = inboundXml(inner, TOKEN, ts, nonce);
    const res = await fetch(`http://127.0.0.1:${port}/callback?msg_signature=forged&timestamp=${ts}&nonce=${nonce}`, {
      method: 'POST', body,
    });
    assert.equal(res.status, 400);
  }

  // /list 走通（验证 router 与 adapter 的完整串联）
  {
    const ts = '1700000004', nonce = 'nD';
    const inner = '<xml><FromUserName><![CDATA[me]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/list]]></Content></xml>';
    const { body, sig } = inboundXml(inner, TOKEN, ts, nonce);
    const res = await fetch(`http://127.0.0.1:${port}/callback?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
      method: 'POST', body,
    });
    const enc = w.extractTag(await res.text(), 'Encrypt');
    assert.match(w.decryptMsg({ aesKey, corpId: CORP, base64: enc }), /node-a \[online\] m1/);
  }

  await new Promise((r) => server.close(r));
});

test('主动发送：gettoken 缓存 + sendText 报文', async () => {
  let tokenCalls = 0, sendBody = null;
  const stub = async (url, opts = {}) => {
    if (String(url).includes('gettoken')) {
      tokenCalls++;
      return { async json() { return { access_token: 'TK', expires_in: 7200 }; } };
    }
    sendBody = JSON.parse(opts.body);
    return { async json() { return { errcode: 0, errmsg: 'ok' }; } };
  };
  const notifier = w.createWecomNotifier({ corpId: CORP, agentId: '1000002', secret: 'S', fetchImpl: stub });
  await notifier.sendText('me', '枢机告警：node-b 离线');
  await notifier.sendText('me', '第二条');
  assert.equal(tokenCalls, 1, 'token 应缓存复用');
  assert.equal(sendBody.touser, 'me');
  assert.equal(sendBody.msgtype, 'text');
  assert.equal(sendBody.agentid, 1000002);
  assert.equal(sendBody.text.content, '第二条');
});
