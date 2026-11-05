'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWeixinAdapter, readState, writeState } = require('../src/adapters/weixin');
const { createRouter } = require('../src/core');
const { createMockIlink } = require('../../../test/mock-ilink');

function makeRouter(allowFrom = ['wx-1']) {
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

function tmpStateFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-wx-')), name);
}

test('handleMessage：白名单用户 /ping 得到 pong 并经 sendmessage 发回', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({
    router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}`,
  });
  const r = await adapter.handleMessage({
    from: 'wx-1', text: '/ping', messageId: 'm1', contextToken: 'ctx-1',
  });
  assert.equal(r.from, 'wx-1');
  assert.equal(ilink.state.sent.length, 1);
  assert.equal(ilink.state.sent[0].to_user_id, 'wx-1');
  assert.equal(ilink.state.sent[0].context_token, 'ctx-1');
  assert.match(ilink.state.sent[0].item_list[0].text_item.text, /^pong · 2026-01-01/);
  await ilink.close();
});

test('handleMessage：陌生人被拒', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({ router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}` });
  await adapter.handleMessage({ from: 'wx-999', text: '/list', messageId: 'm1' });
  assert.match(ilink.state.sent[0].item_list[0].text_item.text, /拒绝访问/);
  await ilink.close();
});

test('handleMessage：群聊消息被忽略（不执行也不回复）', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({ router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}` });
  const r = await adapter.handleMessage({ from: 'wx-1', text: '/ping', messageId: 'm1', groupId: 'g-77' });
  assert.equal(r, null);
  assert.equal(ilink.state.sent.length, 0);
  await ilink.close();
});

test('handleMessage：中文全角斜杠归一化后仍能执行', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({ router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}` });
  await adapter.handleMessage({ from: 'wx-1', text: '／ping', messageId: 'm1' });
  assert.match(ilink.state.sent[0].item_list[0].text_item.text, /^pong/);
  await ilink.close();
});

test('start：收到消息即处理，并把服务端游标原样回传', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({
    router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}`,
    pollTimeoutMs: 5000,
  });
  const handle = adapter.start();
  try {
    ilink.pushUserText({ from: 'wx-1', text: '/ping' });
    // 第一轮轮询时适配器手里的游标还是空的（服务端还没给过任何值），
    // 所以必须等**第二轮**发出去，才能验证「上一轮收到的游标被原样带回」。
    // 只看最后一票的话，消息刚到就跑完断言时会正好落在第一票上——那是个假失败。
    const deadline = Date.now() + 5000;
    while (ilink.state.getUpdatesCalls < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(ilink.state.sent.length, 1, '消息应被处理并回复');
    assert.equal(ilink.state.sent[0].to_user_id, 'wx-1');
    assert.ok(
      ilink.state.getUpdatesCalls >= 2,
      '应已发起第二轮轮询（否则无从验证游标回传）',
    );
    assert.ok(
      ilink.state.lastGetUpdatesBody.get_updates_buf.startsWith('buf-'),
      'get_updates_buf 未按服务端游标回传：' + JSON.stringify(ilink.state.lastGetUpdatesBody),
    );
    assert.equal(ilink.state.lastGetUpdatesBody.get_updates_buf, ilink.state.buf,
      '请求体里的游标必须与适配器持有的一致');
  } finally {
    handle.stop();
    await ilink.close();
  }
});

test('start：getupdates 首次失败后按退避重试并最终恢复', async () => {
  const ilink = createMockIlink({ failFirstGetUpdates: true });
  const port = await ilink.listen();
  const slept = [];
  const adapter = createWeixinAdapter({
    router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}`,
    pollTimeoutMs: 5000, sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
  });
  const handle = adapter.start();
  try {
    const deadline = Date.now() + 3000;
    while (ilink.state.getUpdatesCalls < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(slept.length >= 1, '失败后应退避重试');
    assert.equal(slept[0], 1000, '首次退避 1 秒');
    assert.ok(ilink.state.getUpdatesCalls >= 2, '重试后应再次调用 getupdates');
  } finally {
    handle.stop();
    await ilink.close();
  }
});

test('start：stop 后立即中止在途长轮询', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({
    router: makeRouter(), token: 'tok', apiBase: `http://127.0.0.1:${port}`,
    pollTimeoutMs: 60000,
  });
  const handle = adapter.start();
  await new Promise((r) => setTimeout(r, 100));
  handle.stop();
  assert.equal(handle.stopped, true);
  await ilink.close();
});

test('状态文件：未登录时 start 不启动轮询', async () => {
  const ilink = createMockIlink();
  const port = await ilink.listen();
  const logged = [];
  const adapter = createWeixinAdapter({
    router: makeRouter(), token: '', apiBase: `http://127.0.0.1:${port}`,
    logger: { debug() {}, info() {}, warn() {}, error: (m) => logged.push(m) },
  });
  assert.equal(adapter.token, '');
  const handle = adapter.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ilink.state.getUpdatesCalls, 0);
  assert.ok(logged.some((m) => /未登录/.test(m)), '应明确提示未登录');
  handle.stop();
  await ilink.close();
});

test('状态文件：令牌从磁盘恢复，且权限为 0600', async () => {
  const file = tmpStateFile('weixin-state.json');
  writeState(file, { token: 'tok-from-disk', baseUrl: 'https://ilinkai.weixin.qq.com', getUpdatesBuf: 'buf-7' });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, '令牌文件必须 0600');

  const ilink = createMockIlink();
  const port = await ilink.listen();
  const adapter = createWeixinAdapter({
    router: makeRouter(), token: '', stateFile: file, apiBase: `http://127.0.0.1:${port}`,
  });
  assert.equal(adapter.token, 'tok-from-disk');
  const handle = adapter.start();
  try {
    await adapter.handleMessage({ from: 'wx-1', text: '/ping', messageId: 'm1' });
    assert.equal(ilink.state.sent.length, 1);
    // 鉴权头用的就是磁盘上那个令牌
    assert.equal(ilink.state.lastHeaders.authorization, 'Bearer tok-from-disk');
  } finally {
    handle.stop();
    await ilink.close();
  }
  const back = readState(file);
  assert.equal(back.token, 'tok-from-disk');
  assert.equal(back.getUpdatesBuf, 'buf-7');
});

test('状态文件：损坏或空令牌按未登录处理', () => {
  const file = tmpStateFile('weixin-state.json');
  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.equal(readState(file), null);
  fs.writeFileSync(file, JSON.stringify({ token: '   ' }));
  assert.equal(readState(file), null);
  assert.equal(readState(path.join(path.dirname(file), 'no-such-file.json')), null);
});
