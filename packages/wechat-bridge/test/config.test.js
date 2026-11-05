'use strict';
/**
 * 配置装配与红线：validateConfig、公网绑定防护、三适配器装配。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridgeFromEnv, validateConfig } = require('../src/index');
const { createTelegramAdapter } = require('../src/adapters/telegram');
const { createMockTelegram } = require('../../../test/mock-telegram');

const BASE = {
  MC_BASE: 'http://127.0.0.1:3000',
  MC_API_KEY: 'k',
  WECHAT_ALLOW_FROM: 'me',
  AUDIT_LOG: 'none',
};

test('validateConfig：白名单缺失即报错（红线）', () => {
  const r = validateConfig({ MC_BASE: 'http://x', MC_API_KEY: 'k' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /白名单/.test(e)));
});

test('validateConfig：ADAPTER=telegram 必须要机器人令牌', () => {
  const r = validateConfig({ ...BASE, ADAPTER: 'telegram' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /TELEGRAM_BOT_TOKEN/.test(e)));
});

// 不含 WECHAT_ALLOW_FROM 的底座：下面几个用例专门验「只配了一个入口」的情形
const NO_WECHAT = {
  MC_BASE: 'http://127.0.0.1:3000',
  MC_API_KEY: 'k',
  AUDIT_LOG: 'none',
};
const TG = { ADAPTER: 'telegram', TELEGRAM_BOT_TOKEN: 'T' };

test('validateConfig：ADAPTER=telegram 却没配 Telegram 白名单 → 启动即失败', () => {
  // 一个进程只跑一个适配器，白名单取并集不会越权（微信消息到不了 telegram 适配器）。
  // 但 Telegram 消息也只会到这个适配器——它自己的白名单为空，服务就是白起来：
  // 能启动、不报错，然后拒绝每一个真实用户。没有正当配置长这样，按错误处理。
  const r = validateConfig({ ...NO_WECHAT, ...TG, WECHAT_ALLOW_FROM: 'wx-me' });
  assert.equal(r.ok, false, JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /TELEGRAM_ALLOW_FROM 为空/.test(e)), JSON.stringify(r.errors));
  // 另一入口的白名单确实进了并集（不会因为报错就丢弃）
  assert.deepEqual(r.allowFrom, ['wx-me']);
});

test('validateConfig：ADAPTER=http 却没配微信白名单 → 启动即失败', () => {
  const r = validateConfig({ ...NO_WECHAT, ADAPTER: 'http', TELEGRAM_ALLOW_FROM: 'tg-me' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /WECHAT_ALLOW_FROM 为空/.test(e)));
});

test('validateConfig：ADAPTER=wecom 却没配微信白名单 → 启动即失败', () => {
  const r = validateConfig({
    ...NO_WECHAT, ADAPTER: 'wecom', TELEGRAM_ALLOW_FROM: 'tg-me',
    WECOM_TOKEN: 't', WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', WECOM_CORP_ID: 'ww1',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /WECHAT_ALLOW_FROM 为空/.test(e)));
});

test('validateConfig：两个入口的白名单都填时互不干扰', () => {
  const r = validateConfig({
    ...BASE, WECHAT_ALLOW_FROM: 'wx-me', TELEGRAM_ALLOW_FROM: 'tg-me',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.wechatFrom, ['wx-me']);
  assert.deepEqual(r.telegramFrom, ['tg-me']);
  assert.deepEqual([...r.allowFrom].sort(), ['tg-me', 'wx-me']);
  assert.equal(r.warnings.some((w) => /为空/.test(w)), false, JSON.stringify(r.warnings));
});

test('validateConfig：两个入口的白名单都为空即报错', () => {
  const r = validateConfig({ ...NO_WECHAT, ...TG });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /白名单/.test(e)));
});

test('validateConfig：TELEGRAM_VALIDATE_TOKEN / DRAIN_BACKLOG 拼错即报错', () => {
  for (const v of ['yes', 'true', 'on', '2']) {
    const r = validateConfig({ ...NO_WECHAT, ...TG, TELEGRAM_ALLOW_FROM: '1', TELEGRAM_VALIDATE_TOKEN: v });
    assert.equal(r.ok, false, `VALIDATE_TOKEN=${v} 应被拒`);
    assert.ok(r.errors.some((e) => /TELEGRAM_VALIDATE_TOKEN/.test(e)));
    const r2 = validateConfig({ ...NO_WECHAT, ...TG, TELEGRAM_ALLOW_FROM: '1', TELEGRAM_DRAIN_BACKLOG: v });
    assert.equal(r2.ok, false, `DRAIN_BACKLOG=${v} 应被拒`);
  }
  for (const v of ['0', '1']) {
    assert.equal(
      validateConfig({ ...NO_WECHAT, ...TG, TELEGRAM_ALLOW_FROM: '1', TELEGRAM_VALIDATE_TOKEN: v }).ok,
      true, `VALIDATE_TOKEN=${v} 应放行`,
    );
    assert.equal(
      validateConfig({ ...NO_WECHAT, ...TG, TELEGRAM_ALLOW_FROM: '1', TELEGRAM_DRAIN_BACKLOG: v }).ok,
      true, `DRAIN_BACKLOG=${v} 应放行`,
    );
  }
});

test('validateConfig：ADAPTER=wecom 校验四项配置', () => {
  assert.equal(validateConfig({ ...BASE, ADAPTER: 'wecom' }).ok, false);
  const ok = validateConfig({
    ...BASE, ADAPTER: 'wecom',
    WECOM_TOKEN: 't', WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', WECOM_CORP_ID: 'ww1',
  });
  assert.equal(ok.ok, true);
});

test('validateConfig：未知 ADAPTER 与非法 PORT 被拒', () => {
  assert.equal(validateConfig({ ...BASE, ADAPTER: 'slack' }).ok, false);
  assert.equal(validateConfig({ ...BASE, PORT: 'abc' }).ok, false);
  assert.equal(validateConfig({ ...BASE, PORT: '8080' }).ok, true);
});

test('validateConfig：未配 BRIDGE_TOKEN / AUDIT_LOG 时给警告（不阻断）', () => {
  const r = validateConfig({ MC_BASE: 'http://x', MC_API_KEY: 'k', WECHAT_ALLOW_FROM: 'me' });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /BRIDGE_TOKEN/.test(w)));
  assert.ok(r.warnings.some((w) => /AUDIT_LOG/.test(w)));
});

test('红线：拒绝绑定 0.0.0.0（除非显式 ALLOW_PUBLIC_BIND=1）', () => {
  assert.throws(
    () => createBridgeFromEnv({ ...BASE, HOST: '0.0.0.0', PORT: '0', BRIDGE_TOKEN: 't' }),
    /不得暴露公网/,
  );
  // 显式 opted-in 后放行（此处用随机端口起真服务再关掉）
  const b = createBridgeFromEnv({ ...BASE, HOST: '0.0.0.0', PORT: '0', ALLOW_PUBLIC_BIND: '1' });
  assert.ok(b.server);
  b.server.closeAllConnections();
  b.server.close();
});

test('红线：127.0.0.1 与 Tailscale 地址正常放行', () => {
  for (const host of ['127.0.0.1', '100.64.0.5']) {
    const b = createBridgeFromEnv({ ...BASE, HOST: host, PORT: '0' });
    assert.ok(b.server, host);
    b.server.closeAllConnections();
    b.server.close();
  }
});

test('装配：ADAPTER=telegram 起长轮询、不监听端口', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const b = createBridgeFromEnv({
    ...BASE,
    ADAPTER: 'telegram', TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_ALLOW_FROM: 'tg-me',          // 当前适配器自己的白名单必须非空，否则拒绝装配
    TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
    TELEGRAM_DRAIN_BACKLOG: '0',
  });
  assert.ok(b.polling);
  assert.equal(b.server, undefined, '长轮询无监听端口');
  b.polling.stop();
  await tg.close();
});

test('装配：BRIDGE_TOKEN 透传到 HTTP 适配器（鉴权真正生效）', async () => {
  const b = createBridgeFromEnv({ ...BASE, HOST: '127.0.0.1', PORT: '0', BRIDGE_TOKEN: 'tok' });
  await new Promise((r) => b.server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${b.server.address().port}`;
    const noTok = await fetch(base + '/openclaw', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me', text: '/ping' }),
    });
    assert.equal(noTok.status, 401);
    const withTok = await fetch(base + '/openclaw', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ from: 'me', text: '/ping' }),
    });
    assert.equal(withTok.status, 200);
    // 审计默认落在 audit.jsonl（显式 none 时关闭）
    assert.equal(b.router.stats.snapshot().commands, 1);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
  }
});

test('装配：微信 + Telegram 白名单合并生效（两侧 ID 都能过）', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const b = createBridgeFromEnv({
    MC_BASE: 'http://127.0.0.1:3000', MC_API_KEY: 'k', AUDIT_LOG: 'none',
    WECHAT_ALLOW_FROM: 'wx-me', TELEGRAM_ALLOW_FROM: '12345',
    ADAPTER: 'telegram', TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_DRAIN_BACKLOG: '0',
  });
  try {
    // 白名单里的 Telegram 数字 ID 与微信 ID 都放行
    assert.match(await b.router.handle('/ping', '12345'), /^pong/);
    assert.match(await b.router.handle('/ping', 'wx-me'), /^pong/);
    assert.match(await b.router.handle('/ping', 'other'), /拒绝访问/);
  } finally {
    b.polling.stop();
    await tg.close();
  }
});

test('createTelegramAdapter：默认构造即可用（token 缺失才抛错）', () => {
  assert.throws(() => createTelegramAdapter({ router: { handle: async () => '' } }), /TELEGRAM_BOT_TOKEN/);
});

// ---- 启动即校验：光有 --check 不够，systemd/compose 起服务时没人会加那个参数 ----
test('装配：配置错了就抛错，不让「能启动但服务不了任何人」的进程跑起来', () => {
  // telegram 适配器 + 只有微信白名单：validateConfig 给的是警告时，这个进程会
  // 正常启动、然后拒绝每一个真实用户，日志里一行提示都没有。
  assert.throws(
    () => createBridgeFromEnv({ ...NO_WECHAT, ...TG, WECHAT_ALLOW_FROM: 'wx-me' }),
    /TELEGRAM_ALLOW_FROM 为空/,
  );
  // 开关拼错同理：此前只有 --check 会报，服务照起
  assert.throws(
    () => createBridgeFromEnv({ ...NO_WECHAT, ...TG, TELEGRAM_ALLOW_FROM: '1', TELEGRAM_VALIDATE_TOKEN: 'yes' }),
    /TELEGRAM_VALIDATE_TOKEN/,
  );
  // 白名单全空：红线，两种入口都没配
  assert.throws(() => createBridgeFromEnv({ ...NO_WECHAT, ...TG }), /至少配置一个/);
});

test('装配：合法配置不带错误地起来（告警只进日志，不阻断）', async () => {
  const tg = createMockTelegram();
  const port = await tg.listen();
  const b = createBridgeFromEnv({
    ...BASE,
    ADAPTER: 'telegram', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_ALLOW_FROM: 'tg-me',
    TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_DRAIN_BACKLOG: '0',
  });
  try {
    assert.ok(b.polling);
  } finally {
    b.polling.stop();
    await tg.close();
  }
});

test('validateConfig：AUDIT_LOG 告警对 telegram 适配器也生效', () => {
  // 审计与适配器无关：长轮询同样全量留痕。漏配时它会静默写进 cwd
  // （用户级单元的 cwd 就是 $HOME），所以这条告警不能只在 http 分支里。
  const { AUDIT_LOG: _drop, ...noAudit } = NO_WECHAT;
  const r = validateConfig({ ...noAudit, ...TG, TELEGRAM_ALLOW_FROM: '1' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /AUDIT_LOG/.test(w)), JSON.stringify(r.warnings));
});

test('validateConfig：PORT=0 允许（内核挑端口）但告警，非数字仍拒绝', () => {
  const zero = validateConfig({ ...BASE, PORT: '0' });
  assert.equal(zero.ok, true, JSON.stringify(zero.errors));
  assert.ok(zero.warnings.some((w) => /PORT=0/.test(w)), JSON.stringify(zero.warnings));
  assert.equal(validateConfig({ ...BASE, PORT: 'abc' }).ok, false);
  assert.equal(validateConfig({ ...BASE, PORT: '99999' }).ok, false);
});

// ---- 微信（iLink）适配器：ADAPTER=weixin ----
const WX = { ADAPTER: 'weixin', WECHAT_ALLOW_FROM: 'wx-me' };

test('validateConfig：ADAPTER=weixin 没有令牌也没有登录态 → 启动即失败', () => {
  // 这个进程会启动成功然后一条消息也收不到，所以启动时就挡下，并指路 --login。
  const r = validateConfig({ ...BASE, ...WX });
  assert.equal(r.ok, false, JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /没有可用令牌/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /--login/.test(e)), JSON.stringify(r.errors));
});

test('validateConfig：ADAPTER=weixin 有 WECHAT_BOT_TOKEN 即可启动', () => {
  const r = validateConfig({ ...BASE, ...WX, WECHAT_BOT_TOKEN: 'tok' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateConfig：ADAPTER=weixin 有登录态文件即可启动', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-cfg-')), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'tok-from-disk' }), { mode: 0o600 });
  const r = validateConfig({ ...BASE, ...WX, WECHAT_STATE_FILE: file });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateConfig：WECHAT_STATE_FILE 必须是绝对路径', () => {
  const r = validateConfig({ ...BASE, ...WX, WECHAT_BOT_TOKEN: 'tok', WECHAT_STATE_FILE: 'state.json' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /WECHAT_STATE_FILE 必须是绝对路径/.test(e)), JSON.stringify(r.errors));
});

test('validateConfig：ADAPTER=weixin 却没配微信白名单 → 启动即失败', () => {
  const r = validateConfig({ ...NO_WECHAT, ADAPTER: 'weixin', WECHAT_BOT_TOKEN: 'tok' });
  assert.equal(r.ok, false, JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /WECHAT_ALLOW_FROM 为空/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /微信/.test(e)), JSON.stringify(r.errors));
});

test('装配：ADAPTER=weixin 起长轮询、不监听端口', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-cfg-')), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'tok-disk' }), { mode: 0o600 });
  const b = createBridgeFromEnv({ ...BASE, ...WX, WECHAT_STATE_FILE: file });
  try {
    assert.ok(b.polling, '应返回轮询句柄');
    assert.equal(b.server, undefined, '长轮询适配器没有监听端口');
    assert.equal(b.adapter, 'weixin');
  } finally {
    b.polling.stop();
  }
});
