'use strict';
/**
 * 网页面板：会话鉴权、只读边界、登录限流。
 * 面板是新的攻击面，所以这里逐条钉住它的安全属性，而不是只测渲染。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPanel, parseCookies, sign, COOKIE_NAME, DEFAULT_SESSION_TTL_MS } = require('../src/panel');
const { createControlServer } = require('../src/server');
const { createStore } = require('../src/store');
const { createRateLimiter } = require('../src/ratelimit');
const { parseConfig } = require('../src/config');

const API_KEY = 'k'.repeat(32);

function makeStore(dir) {
  return createStore({ dbPath: `${dir}/mc.db`, now: () => Date.now(), logger: { debug() {}, info() {}, warn() {}, error() {} } });
}

function makeServer(store, extra = {}) {
  const { config } = parseConfig({ MC_API_KEY: API_KEY, ...extra }, { cwd: '/tmp' });
  const panel = createPanel({
    store, config, now: extra.now || (() => Date.now()),
    loginLimiter: createRateLimiter({ perMinute: 5, burst: 5 }),
  });
  return createControlServer({ config, store, panel });
}

async function withServer(fn) {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-panel-'));
  const store = makeStore(dir);
  const srv = makeServer(store);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    await srv.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cookieFrom(res) {
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(new RegExp(`${COOKIE_NAME}=([^;]*)`));
  return m ? m[1] : '';
}

async function login(base, key = API_KEY) {
  const res = await fetch(`${base}/panel/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  return { res, cookie: cookieFrom(res) };
}

test('parseCookies：分号与等号都按 Cookie 头格式切', () => {
  assert.deepEqual(parseCookies({ headers: { cookie: 'a=1; b=2' } }), { a: '1', b: '2' });
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('会话 Cookie：三段结构，改任何一段都验不过', () => {
  const sid = 'a'.repeat(32);
  const exp = String(Date.now() + 60000);
  const good = `${sid}.${exp}.${sign(API_KEY, sid, exp)}`;
  const parts = good.split('.');
  assert.equal(parts.length, 3);
  // 篡改过期时间：签名对不上
  assert.notEqual(sign(API_KEY, sid, String(Number(exp) + 1)), parts[2]);
  // 换一把 Key：签名对不上
  assert.notEqual(sign('other-key', sid, exp), parts[2]);
  // 换会话号：签名对不上
  assert.notEqual(sign(API_KEY, 'b'.repeat(32), exp), parts[2]);
});

test('GET /panel：未登录也返回页面（登录表单在页面里）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/panel`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /枢机 · 控制面板/);
    assert.match(html, /panel\/login/);
    assert.ok(!/MC_API_KEY/.test(html), '页面里不得出现 API Key 字样以外的密钥提示');
  });
});

test('GET /panel/api/snapshot：无会话 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/panel/api/snapshot`);
    assert.equal(res.status, 401);
  });
});

test('面板页面：所有 fetch 都是绝对路径（/panel/ 带尾斜杠时不会拼错）', async () => {
  // 相对路径的坑：用户访问 /panel/ （浏览器很爱补尾斜杠），前端 fetch('panel/login')
  // 会解析成 /panel/panel/login → 404，而 404 又被显示成「API Key 不正确」，
  // 于是正确的密钥也进不来，且报错指向完全错误的方向。
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel`)).text();
    const paths = [...html.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(paths.length >= 4, '应至少覆盖 session / login / snapshot / logout 四处，实际：' + JSON.stringify(paths));
    for (const p of paths) {
      assert.ok(p.startsWith('/'), '面板端点必须用绝对路径：' + p);
      assert.ok(p.startsWith('/panel/'), '面板端点必须挂在 /panel/ 下：' + p);
    }
    // 页面里不得残留相对写法
    assert.ok(!/fetch\('(?!\/)/.test(html), '仍有相对路径的 fetch');
  });
});

test('面板端点：/panel/ 带尾斜杠也返回页面，且 /panel/panel/* 明确 404', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/`);
    assert.equal(page.status, 200, '带尾斜杠也要给页面，否则用户看到的是 404 页');
    assert.match(await page.text(), /枢机 · 控制面板/);

    // 这一条把缺陷钉死：只要前端还在用相对路径，这里必然 404
    const doubled = await fetch(`${base}/panel/panel/login`, { method: 'POST' });
    assert.equal(doubled.status, 404, '/panel/panel/login 必须是 404，证明相对路径会拼错');

    const real = await fetch(`${base}/panel/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY }),
    });
    assert.equal(real.status, 200, '绝对路径的登录端点必须可用');
  });
});

test('登录失败按状态码给出准确原因，不把一切都说成密钥错误', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel`)).text();
    // 401 才对应「API Key 不正确」；503 与其它状态码要有自己的文案
    assert.match(html, /面板不可用：服务端未配置密钥/);
    assert.match(html, /登录失败（HTTP /);
    assert.match(html, /会话检查失败（HTTP /);
  });
});

test('登录：正确的 API Key 换到 HttpOnly + SameSite=Strict 的会话 Cookie', async () => {
  await withServer(async (base) => {
    const { res, cookie } = await login(base);
    assert.equal(res.status, 200);
    assert.ok(cookie, '应下发会话 Cookie');
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, new RegExp(`Max-Age=${Math.floor(DEFAULT_SESSION_TTL_MS / 1000)}`));
  });
});

test('登录：错误的 API Key 401 且不下发 Cookie', async () => {
  await withServer(async (base) => {
    const { res, cookie } = await login(base, 'wrong-key-entirely');
    assert.equal(res.status, 401);
    assert.equal(cookie, '');
  });
});

test('快照：登录后拿得到汇总与 Agent 明细', async () => {
  await withServer(async (base, store) => {
    store.applyHeartbeat({ agentId: 'node-a', status: 'online', model: 'm1', usage: { tokens: 1200, costUsd: 0.5 } });
    store.applyHeartbeat({ agentId: 'node-b', status: 'online', model: 'm2', usage: { tokens: 300, costUsd: 0.1 } });
    const { cookie } = await login(base);
    const res = await fetch(`${base}/panel/api/snapshot`, { headers: { cookie: `${COOKIE_NAME}=${cookie}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totals.agents, 2);
    assert.equal(body.totals.online, 2);
    assert.equal(body.totals.tokens, 1500);
    assert.equal(body.agents.length, 2);
    assert.equal(body.byAgent['node-a'].tokens, 1200);
    // 心跳详情可能带命令原文，不得进浏览器
    for (const a of body.agents) {
      assert.ok(!('detail' in a), 'Agent 明细不得包含 detail 字段');
      assert.ok(!('heartbeats' in a), 'Agent 明细不得包含心跳流水');
    }
  });
});

test('快照：会话被篡改（换会话号 / 改过期时间）一律 401', async () => {
  await withServer(async (base) => {
    const { cookie } = await login(base);
    const [sid, exp, mac] = cookie.split('.');
    for (const bad of [
      `${'0'.repeat(32)}.${exp}.${mac}`,        // 换会话号
      `${sid}.${Number(exp) + 60000}.${mac}`,   // 改过期时间
      `${sid}.${exp}.${'x'.repeat(43)}`,        // 换签名
      `${sid}.${exp}`,                          // 少一段
    ]) {
      const res = await fetch(`${base}/panel/api/snapshot`, { headers: { cookie: `${COOKIE_NAME}=${bad}` } });
      assert.equal(res.status, 401, `篡改后的 Cookie 不应放行：${bad}`);
    }
  });
});

test('快照：过期会话 401（过期时间就在签名里，服务端时钟到了就不认）', async () => {
  await withServer(async (base) => {
    const now = Date.now();
    const sid = 'c'.repeat(32);
    const exp = String(now - 1000); // 已经过期
    const cookie = `${sid}.${exp}.${sign(API_KEY, sid, exp)}`;
    const res = await fetch(`${base}/panel/api/snapshot`, { headers: { cookie: `${COOKIE_NAME}=${cookie}` } });
    assert.equal(res.status, 401);
  });
});

test('退出登录：Cookie 被置空', async () => {
  await withServer(async (base) => {
    const { cookie } = await login(base);
    const res = await fetch(`${base}/panel/logout`, {
      method: 'POST', headers: { cookie: `${COOKIE_NAME}=${cookie}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  });
});

test('登录限流：连续错 5 次后第 6 次直接被挡（429），正确密钥也进不来', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/panel/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'nope' }),
      });
      assert.equal(r.status, 401, `第 ${i + 1} 次应仍在校验密钥`);
    }
    const blocked = await fetch(`${base}/panel/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nope' }),
    });
    assert.equal(blocked.status, 429);
    // 限流是按 IP 的，这时连正确的密钥也进不去——这正是防爆破想要的行为
    const evenRight = await fetch(`${base}/panel/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY }),
    });
    assert.equal(evenRight.status, 429);
  });
});

test('面板是只读的：面板路径下没有任何写端点', async () => {
  await withServer(async (base) => {
    const { cookie } = await login(base);
    const h = { cookie: `${COOKIE_NAME}=${cookie}`, 'Content-Type': 'application/json' };
    // 控制面真正的写端点不在面板前缀下
    for (const [method, path] of [
      ['POST', '/panel/api/tasks'],
      ['POST', '/panel/api/tasks/t-1/claim'],
      ['POST', '/panel/api/tasks/t-1/complete'],
      ['POST', '/panel/api/agents/heartbeat'],
      ['POST', '/panel/api/dispatch'],
      ['DELETE', '/panel/api/agents/node-a'],
    ]) {
      const res = await fetch(`${base}${path}`, { method, headers: h, body: '{}' });
      assert.ok([404, 405].includes(res.status), `${method} ${path} 不应存在，实际 ${res.status}`);
    }
    // 面板挂载点之外的原生端点仍走 Bearer，不会因为面板会话而放行
    const res = await fetch(`${base}/api/agents`, { headers: { cookie: `${COOKIE_NAME}=${cookie}` } });
    assert.equal(res.status, 401, '面板会话不得顶替 Bearer 鉴权');
  });
});

test('MC_PANEL=0 时面板整体关闭', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-panel-off-'));
  const store = makeStore(dir);
  const srv = makeServer(store, { MC_PANEL: '0' });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  try {
    for (const p of ['/panel', '/panel/login', '/panel/api/snapshot']) {
      const res = await fetch(`${base}${p}`, { method: p.endsWith('login') ? 'POST' : 'GET' });
      assert.equal(res.status, 404, `${p} 应随面板一起关闭`);
    }
  } finally {
    await srv.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('面板请求也进审计（与 /api/* 同一套门）', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-panel-audit-'));
  const store = makeStore(dir);
  const auditFile = path.join(dir, 'audit.jsonl');
  const { config } = parseConfig({ MC_API_KEY: API_KEY, MC_AUDIT_LOG: auditFile }, { cwd: dir });
  const srv = createControlServer({
    config, store,
    audit: require('../src/audit').createAudit({ file: auditFile }),
    panel: createPanel({ store, config, loginLimiter: createRateLimiter({ perMinute: 5, burst: 5 }) }),
  });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  try {
    const before = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').length : 0;
    await fetch(`${base}/panel`);
    await fetch(`${base}/panel/api/snapshot`); // 401 也要留痕
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    assert.ok(lines.length >= before + 2, `面板请求应逐条留痕，实际新增 ${lines.length - before} 条`);
    const paths = lines.map((l) => JSON.parse(l).path);
    assert.ok(paths.includes('/panel'), '登录页访问要留痕');
    assert.ok(paths.includes('/panel/api/snapshot'), '被拒的快照请求也要留痕');
  } finally {
    await srv.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
