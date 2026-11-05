'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLossless, extractTextMessages, createIlinkClient, encodeClientVersion,
  DEFAULT_BASE, DEFAULT_BOT_TYPE, ITEM_TYPE, MSG_TYPE, CHANNEL_VERSION,
} = require('../src/ilink');

// 版本号来自 package.json：写死数字的话每次发版都会把这条断言弄红
const BRIDGE_VERSION = require('../package.json').version;

test('parseLossless：uint64 的 message_id 不丢精度', () => {
  // 2^53+1 这个数用 JS number 存不下来，裸 JSON.parse 会把它变成 9007199254740992
  const raw = '{"ret":0,"msgs":[{"message_id":9007199254740993,"item_list":[{"msg_id":18446744073709551615}]}]}';
  const data = parseLossless(raw);
  assert.equal(typeof data.msgs[0].message_id, 'string');
  assert.equal(data.msgs[0].message_id, '9007199254740993');
  assert.equal(data.msgs[0].item_list[0].msg_id, '18446744073709551615');
  // 普通数字字段不受影响
  assert.equal(data.ret, 0);
});

test('parseLossless：字符串内容里的同名字段不被误改', () => {
  const raw = '{"text":"注意 message_id: 9007199254740993 这个数字","message_id":123}';
  const data = parseLossless(raw);
  assert.equal(data.text, '注意 message_id: 9007199254740993 这个数字');
  assert.equal(data.message_id, '123');
});

test('parseLossless：负数与无小数位的大数原样保留', () => {
  assert.deepEqual(parseLossless('{"message_id":-42,"a":1}'), { message_id: '-42', a: 1 });
  assert.deepEqual(parseLossless('{"message_id":0,"a":1}'), { message_id: '0', a: 1 });
});

test('encodeClientVersion：0x00MMNNPP 编码', () => {
  assert.equal(encodeClientVersion('1.0.11'), 0x0001000b);
  assert.equal(encodeClientVersion('0.2.0'), 0x00000200);
  assert.equal(encodeClientVersion('2.4.10'), 0x0002040a);
});

test('extractTextMessages：只取用户发来的文本，非文本与机器人消息忽略', () => {
  const out = extractTextMessages([
    { message_type: MSG_TYPE.USER, from_user_id: 'wx-1', item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '/ping' } }] },
    { message_type: MSG_TYPE.USER, from_user_id: 'wx-1', item_list: [{ type: ITEM_TYPE.IMAGE }] },
    { message_type: MSG_TYPE.USER, from_user_id: 'wx-1', item_list: [{ type: ITEM_TYPE.VOICE }] },
    { message_type: MSG_TYPE.BOT, from_user_id: 'wx-1', item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '我发的' } }] },
    { message_type: MSG_TYPE.USER, from_user_id: '', item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '无来源' } }] },
    { message_type: MSG_TYPE.USER, from_user_id: 'wx-1', item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '   ' } }] },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, 'wx-1');
  assert.equal(out[0].text, '/ping');
});

test('extractTextMessages：多段文本拼接', () => {
  const out = extractTextMessages([{
    message_type: 1, from_user_id: 'wx-1',
    item_list: [
      { type: 1, text_item: { text: '/dispatch node-a ' } },
      { type: 1, text_item: { text: '跑一次构建' } },
    ],
  }]);
  assert.equal(out[0].text, '/dispatch node-a 跑一次构建');
});

test('createIlinkClient：请求头带 iLink 身份与 Bearer 令牌', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, method: init.method });
    return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'b1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const c = createIlinkClient({ baseUrl: 'https://example.invalid/', token: 'tok-1', fetchImpl });
  await c.getUpdates('b0');
  assert.equal(seen[0].url, 'https://example.invalid/ilink/bot/getupdates');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.Authorization, 'Bearer tok-1');
  assert.equal(seen[0].headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(seen[0].headers['iLink-App-Id'], 'bot');
  assert.equal(seen[0].headers['iLink-App-ClientVersion'], String(encodeClientVersion(BRIDGE_VERSION)));
  assert.ok(seen[0].headers['X-WECHAT-UIN'], 'X-WECHAT-UIN 必须存在');
});

test('createIlinkClient：默认接入点与机器人类型', () => {
  const c = createIlinkClient({ token: 't', fetchImpl: async () => new Response('{}') });
  assert.equal(c.baseUrl, DEFAULT_BASE);
  assert.equal(DEFAULT_BOT_TYPE, '3');
});

test('getUpdates：客户端超时按正常控制流返回空响应', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const c = createIlinkClient({ token: 't', fetchImpl, timeoutMs: 20 });
  const r = await c.getUpdates('buf-9', { timeoutMs: 20 });
  assert.deepEqual(r, { ret: 0, msgs: [], get_updates_buf: 'buf-9' });
});

test('sendText：ret 非 0 时抛出带原始响应的错误', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ret: 1001, errmsg: 'token 失效' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const c = createIlinkClient({ token: 't', fetchImpl });
  await assert.rejects(() => c.sendText('wx-1', 'hi'), (e) => {
    assert.match(e.message, /ret=1001/);
    assert.equal(e.ilink.errmsg, 'token 失效');
    return true;
  });
});

test('sendText：消息体形状正确', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ret: 0, message_id: 's1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const c = createIlinkClient({ token: 't', fetchImpl });
  await c.sendText('wx-42', 'pong', { contextToken: 'ctx-1' });
  assert.equal(bodies[0].msg.to_user_id, 'wx-42');
  assert.equal(bodies[0].msg.message_type, MSG_TYPE.BOT);
  assert.equal(bodies[0].msg.item_list[0].type, ITEM_TYPE.TEXT);
  assert.equal(bodies[0].msg.item_list[0].text_item.text, 'pong');
  assert.equal(bodies[0].msg.context_token, 'ctx-1');
});
