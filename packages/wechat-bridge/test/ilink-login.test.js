'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWeixinLogin } = require('../src/ilink-login');
const { createMockIlink } = require('../../../test/mock-ilink');

function tmpStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-login-')), 'weixin-state.json');
}

async function withIlink(opts, fn) {
  const ilink = createMockIlink(opts);
  const port = await ilink.listen();
  try {
    await fn(ilink, port);
  } finally {
    await ilink.close();
  }
}

test('登录：confirmed 后令牌落盘（0600）并返回扫码账号 ID', async () => {
  await withIlink({ statusScript: ['wait', 'confirmed'] }, async (ilink, port) => {
    const file = tmpStateFile();
    const result = await runWeixinLogin({
      apiBase: `http://127.0.0.1:${port}`,
      stateFile: file,
      print: () => {},
      sleepImpl: () => Promise.resolve(),
    });
    assert.equal(result.connected, true);
    assert.equal(result.botToken, 'tok-xyz');
    assert.equal(result.botId, 'bot-123');
    assert.equal(result.userId, 'wx-user-42');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.token, 'tok-xyz');
    assert.equal(onDisk.botId, 'bot-123');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // 二维码请求与状态轮询都真的打到了桩上
    assert.ok(ilink.state.calls.some((c) => c.method.endsWith('/get_bot_qrcode')));
    assert.ok(ilink.state.calls.some((c) => c.method.endsWith('/get_qrcode_status')));
  });
});

test('登录：二维码与配对数字都走了真实端点', async () => {
  await withIlink({ statusScript: ['need_verifycode', 'confirmed'] }, async (ilink, port) => {
    const prompts = [];
    const result = await runWeixinLogin({
      apiBase: `http://127.0.0.1:${port}`,
      stateFile: tmpStateFile(),
      print: () => {},
      sleepImpl: () => Promise.resolve(),
      readVerifyCode: async (p) => { prompts.push(p); return '1234'; },
    });
    assert.equal(result.connected, true);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /输入手机微信上显示的数字/);
    // 配对码要作为 verify_code 查询参数带上
    const statusCalls = ilink.state.calls.filter((c) => c.method.endsWith('/get_qrcode_status'));
    assert.ok(
      statusCalls.some((c) => c.query.includes('verify_code=1234')),
      '服务端要求配对数字时，必须把输入的数字回传给服务端',
    );
  });
});

test('登录：非交互终端收到 need_verifycode 直接报错', async () => {
  await withIlink({ statusScript: ['need_verifycode'] }, async (ilink, port) => {
    await assert.rejects(
      () => runWeixinLogin({
        apiBase: `http://127.0.0.1:${port}`, stateFile: tmpStateFile(), print: () => {},
      }),
      /配对数字/,
    );
  });
});

test('登录：scaned_but_redirect 时轮询切到新接入点', async () => {
  // 重定向目标由服务端指定，代码会原样拼成 https://<redirect_host>。这里用注入的
  // fetch 代替真实网络，才能把两个接入点都握在手里、并核对轮询真的换了地方。
  const REDIRECTED = 'https://ilinkai-redirect.weixin.qq.com';
  const seen = [];
  let statusCalls = 0;
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    const json = (obj) => new Response(JSON.stringify(obj), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    if (String(url).endsWith('/ilink/bot/get_bot_qrcode?bot_type=3')) {
      return json({ qrcode: 'wxqr://abc', qrcode_img_content: 'https://weixin.qq.com/qr/abc' });
    }
    if (String(url).includes('/ilink/bot/get_qrcode_status')) {
      statusCalls++;
      if (statusCalls === 1) return json({ status: 'scaned_but_redirect', redirect_host: 'ilinkai-redirect.weixin.qq.com' });
      return json({
        status: 'confirmed', bot_token: 'tok-xyz', ilink_bot_id: 'bot-123',
        baseurl: REDIRECTED, ilink_user_id: 'wx-user-42',
      });
    }
    throw new Error('unexpected url: ' + url);
  };
  const result = await runWeixinLogin({
    apiBase: 'https://ilinkai.weixin.qq.com', stateFile: tmpStateFile(),
    print: () => {}, sleepImpl: () => Promise.resolve(), fetchImpl,
  });
  assert.equal(result.connected, true);
  assert.equal(statusCalls, 2);
  assert.ok(seen[0].startsWith('https://ilinkai.weixin.qq.com/'), '第一票应打到初始接入点');
  assert.ok(seen[2].startsWith(REDIRECTED + '/'), '重定向后应打到新接入点');
  assert.equal(result.baseUrl, REDIRECTED);
});

test('登录：binded_redirect 视为成功且不覆盖已有令牌', async () => {
  await withIlink({ statusScript: ['binded_redirect'] }, async (ilink, port) => {
    const file = tmpStateFile();
    fs.writeFileSync(file, JSON.stringify({ token: 'old-token' }), { mode: 0o600 });
    const result = await runWeixinLogin({
      apiBase: `http://127.0.0.1:${port}`, stateFile: file,
      print: () => {}, sleepImpl: () => Promise.resolve(),
    });
    assert.equal(result.connected, true);
    assert.equal(result.alreadyConnected, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'old-token');
  });
});

test('登录：二维码过期会刷新（最多三次），超次则报错', async () => {
  await withIlink({ statusScript: ['expired'] }, async (ilink, port) => {
    const prints = [];
    await assert.rejects(
      () => runWeixinLogin({
        apiBase: `http://127.0.0.1:${port}`, stateFile: tmpStateFile(),
        print: (t) => prints.push(t), sleepImpl: () => Promise.resolve(),
      }),
      /二维码多次失效/,
    );
    // 首次取码 + 2 次刷新，共 3 次；第 3 次过期即放弃
    const qrCalls = ilink.state.calls.filter((c) => c.method.endsWith('/get_bot_qrcode'));
    assert.equal(qrCalls.length, 3);
    assert.ok(prints.some((t) => /正在刷新/.test(t)));
  });
});

test('登录：服务端不给二维码时立刻失败', async () => {
  await withIlink({}, async (ilink, port) => {
    // 覆盖桩的默认响应：让它返回空对象
    const realClose = ilink.close;
    await realClose();
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      await assert.rejects(
        () => runWeixinLogin({
          apiBase: `http://127.0.0.1:${port}`, stateFile: tmpStateFile(), print: () => {},
        }),
        /未返回二维码/,
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
