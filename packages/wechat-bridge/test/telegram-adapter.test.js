'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramAdapter } = require('../src/adapters/telegram');
const { createRouter } = require('../src/core');
const { createMockTelegram } = require('../../../test/mock-telegram');

function makeRouter(allowFrom = ['111']) {
  return createRouter({
    mc: {
      async get(p) {
        if (p === '/api/agents') return [{ agentId: 'node-a', status: 'online', model: 'm1' }];
        throw new Error('404');
      },
      async post() { return { ok: true, id: 't-1' }; },
    },
    allowFrom, audit: { record() {} }, isoNow: () => '2026-01-01T00:00:00.000Z',
  });
}

function msg(text, fromId, chatId = 222) {
  return { message: { message_id: 1, from: { id: fromId }, chat: { id: chatId }, text } };
}

test('handleUpdate：白名单用户 /ping 回 pong', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  const r = await adapter.handleUpdate(msg('/ping', 111));
  assert.equal(r.from, '111');
  assert.equal(tg.state.sent.length, 1);
  assert.equal(tg.state.sent[0].chat_id, 222);
  assert.match(tg.state.sent[0].text, /^pong · 2026-01-01/);
  await tg.close();
});

test('handleUpdate：陌生人被拒', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  await adapter.handleUpdate(msg('/list', 999));
  assert.match(tg.state.sent[0].text, /拒绝访问/);
  await tg.close();
});

test('handleUpdate：非文本消息忽略', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  const r = await adapter.handleUpdate({ message: { from: { id: 111 }, chat: { id: 222 }, photo: [] } });
  assert.equal(r, null);
  assert.equal(tg.state.sent.length, 0);
  await tg.close();
});

test('start：先丢弃积压，再处理新消息；stop 后停止轮询', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const slept = [];
  const adapter = createTelegramAdapter({
    router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}`,
    drainBacklog: true, sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
  });
  const handle = adapter.start();
  try {
    // 启动前塞两条积压（应被丢弃）
    tg.push(msg('陈旧消息1', 111));
    tg.push(msg('陈旧消息2', 111));
    // 等丢弃完成（drain 的 getUpdates + 正式轮询各至少一次）
    const drained = Date.now() + 3000;
    while (tg.state.getUpdatesCalls < 2 && Date.now() < drained) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // 之后再推新消息（应被处理）
    const fresh = tg.push(msg('/ping', 111));
    const replied = Date.now() + 3000;
    while (tg.state.sent.length === 0 && Date.now() < replied) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(tg.state.sent.length, 1, '只回新消息，积压被丢弃');
    assert.match(tg.state.sent[0].text, /^pong/);
    assert.equal(handle.offset, fresh.update_id + 1, 'offset 推进到新消息之后');
  } finally {
    handle.stop();
  }
  await new Promise((r) => setTimeout(r, 50));
  await tg.close();
});

test('start：getUpdates 429 后指数退避重试并恢复', async () => {
  const tg = createMockTelegram({ failFirstGetUpdates: true });
  const port = await tg.listen();
  const slept = [];
  const adapter = createTelegramAdapter({
    router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}`,
    drainBacklog: false, sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
  });
  const handle = adapter.start();
  try {
    const deadline = Date.now() + 3000;
    while (tg.state.getUpdatesCalls < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(slept, [1000], '首次失败退避 1s');
    assert.ok(tg.state.getUpdatesCalls >= 2, '失败后重试');
  } finally {
    handle.stop();
  }
  await new Promise((r) => setTimeout(r, 50));
  await tg.close();
});

test('start：drainBacklog=false 时处理积压', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({
    router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}`,
    drainBacklog: false, sleepImpl: () => Promise.resolve(),
  });
  tg.push(msg('/ping', 111));
  const handle = adapter.start();
  try {
    const deadline = Date.now() + 3000;
    while (tg.state.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(tg.state.sent.length, 1);
  } finally {
    handle.stop();
  }
  await new Promise((r) => setTimeout(r, 50));
  await tg.close();
});

test('call：Telegram 返回 ok:false 抛错并带 tgError', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  await assert.rejects(
    () => adapter.call('getMe', {}),
    (e) => /getMe 失败/.test(e.message) && e.tgError && e.tgError.error_code === 429,
  );
  await tg.close();
});

test('缺 token 直接报错', () => {
  assert.throws(() => createTelegramAdapter({ router: makeRouter() }), /TELEGRAM_BOT_TOKEN/);
});

// ---- 群聊：机器人一旦被拉进群，群里每个人的消息都会走到这里 ----
test('handleUpdate：群聊消息被忽略，不往群里回「拒绝访问」', async () => {
  // 陌生人成员会触发白名单拒绝，而回复发往 msg.chat.id——也就是群。
  // 那既刷屏，又等于向全群公告「这机器人有白名单、谁不在名单里」。
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  const group = {
    message: {
      message_id: 9, from: { id: 999 }, text: '/ping',
      chat: { id: -100123, type: 'group', title: '某群' },
    },
  };
  const r = await adapter.handleUpdate(group);
  assert.equal(r, null, '群聊消息应被忽略');
  assert.equal(tg.state.sent.length, 0, '不应往群里发任何东西');
  await tg.close();
});

test('handleUpdate：supergroup / channel 同样忽略', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  for (const type of ['supergroup', 'channel']) {
    const r = await adapter.handleUpdate({
      message: { message_id: 1, from: { id: 111 }, text: '/ping', chat: { id: -55, type } },
    });
    assert.equal(r, null, type);
  }
  assert.equal(tg.state.sent.length, 0);
  await tg.close();
});

test('handleUpdate：私聊照常处理（含白名单用户与陌生人）', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  const priv = {
    message: { message_id: 2, from: { id: 111 }, text: '/ping', chat: { id: 222, type: 'private' } },
  };
  const r = await adapter.handleUpdate(priv);
  assert.equal(r.from, '111');
  assert.equal(tg.state.sent.length, 1);
  assert.match(tg.state.sent[0].text, /^pong/);
  await tg.close();
});

test('handleUpdate：chat 缺 type 时按私聊处理（向后兼容旧报文）', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const adapter = createTelegramAdapter({ router: makeRouter(), token: 'T', apiBase: `http://127.0.0.1:${port}` });
  const r = await adapter.handleUpdate(msg('/ping', 111)); // msg() 不带 chat.type
  assert.equal(r.from, '111');
  await tg.close();
});
