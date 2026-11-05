'use strict';
/**
 * 面板内嵌脚本的行为测试。
 *
 * 前面几轮故障都是「页面停在正在载入…」：一次是端点写成相对路径，一次是
 * session 返回 200 + authenticated:false 时没有分支处理。共同点是语法正确、
 * 端点也对，纯字符串断言全都抓不到。所以这里把 script 抽出来，在一个最小 DOM
 * 桩上真的跑一遍，按服务端的每种响应分别验证页面去了哪里。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PAGE_HTML } = require('../src/panel-page');

const INLINE_JS = [...PAGE_HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)][0][1];

function res(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

/**
 * 在最小 DOM 桩上执行面板脚本。
 * routes：URL → 响应；值为 'hang' 时表示永不 resolve（模拟请求挂起）。
 */
function runPage(routes = {}, { hang = false } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '正在载入…',
        textContent: '',
        // 真实 HTML 里 #app 带 aria-busy="true"，自愈定时器靠它判断页面
        // 是否还停在初始状态。桩给成 null 会让自愈逻辑直接返回。
        attrs: id === 'app' ? { 'aria-busy': 'true' } : {},
        style: {},
        classList: { add() {}, remove() {} },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener() {},
        focus() {},
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
      });
    }
    return elements.get(id);
  };
  const calls = [];
  const timers = [];
  const sandbox = {
    document: { getElementById: el, documentElement: el('documentElement') },
    fetch: (url) => {
      calls.push(url);
      if (hang) return new Promise(() => {});
      const hit = routes[url];
      return Promise.resolve(hit || res(404, { message: 'no route ' + url }));
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { reload() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(INLINE_JS, sandbox);
  return { elements, el, calls, timers, sandbox };
}

const SNAPSHOT = {
  generatedAt: '2026-11-05T00:00:00.000Z', staleSec: 900,
  totals: { agents: 1, online: 1, tokens: 0, costUsd: 0, tasks: 0,
    tasksByStatus: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 } },
  agents: [], byAgent: {},
};

/** 让 promise 链跑完：脚本里每层 then 都是一个微任务。 */
async function flush(times = 16) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('面板脚本按服务端响应决定页面去向', () => {
  test('session 401 → 显示登录表单', async () => {
    const p = runPage({ '/panel/api/session': res(401, { message: '未登录' }) });
    await flush();
    assert.match(p.el('app').innerHTML, /API Key/, '401 后应出现登录表单');
    assert.equal(p.el('app').getAttribute('aria-busy'), 'false', '载入中标记应清除');
  });

  test('session 200 + authenticated:false → 显示登录表单', async () => {
    // 服务端对未登录的会话检查返回的是 200 + {"authenticated":false}，不是 401。
    // 少了这个分支，页面既不进登录表单也不报错，永远停在「正在载入…」，
    // 而请求其实成功了——服务端日志里只有一条 200，看不出任何异常。
    const p = runPage({ '/panel/api/session': res(200, { authenticated: false }) });
    await flush();
    assert.match(p.el('app').innerHTML, /API Key/, '未登录必须落到登录表单');
    assert.equal(p.el('app').getAttribute('aria-busy'), 'false');
    assert.ok(!p.calls.includes('/panel/api/snapshot'), '未登录不该去要快照');
  });

  test('session 200 + authenticated:true → 直接要快照并渲染', async () => {
    const p = runPage({
      '/panel/api/session': res(200, { authenticated: true }),
      '/panel/api/snapshot': res(200, SNAPSHOT),
    });
    await flush();
    assert.ok(p.calls.includes('/panel/api/snapshot'), '已登录应去要快照');
    await flush();
    assert.match(p.el('app').innerHTML, /Agent 总数/, '快照回来应渲染面板');
  });

  test('session 检查非 2xx/401（如 404）→ 在表单上显示原因', async () => {
    const p = runPage({ '/panel/api/session': res(404, { message: 'no route' }) });
    await flush();
    assert.match(p.el('app').innerHTML, /API Key/, '仍应落到登录表单');
    assert.match(p.el('err').textContent, /会话检查失败（HTTP 404）/,
      '失败原因要写出来，不能只说一句载入中');
  });

  test('快照 401（会话过期）→ 回到登录表单', async () => {
    const p = runPage({
      '/panel/api/session': res(200, { authenticated: true }),
      '/panel/api/snapshot': res(401, { message: '未登录或会话已过期' }),
    });
    await flush();
    await flush();
    assert.match(p.el('app').innerHTML, /API Key/);
  });

  test('所有面板端点都是绝对路径', async () => {
    const p = runPage({ '/panel/api/session': res(401, {}) });
    await flush();
    assert.ok(p.calls.length >= 1);
    for (const u of p.calls) {
      assert.ok(u.startsWith('/panel/'), '端点必须绝对：' + u);
    }
  });

  test('登录失败按状态码给出不同文案', () => {
    for (const [status, expected] of [
      [401, /API Key 不正确/],
      [429, /尝试过于频繁/],
      [503, /面板不可用：服务端未配置密钥/],
      [500, /登录失败（HTTP /],
    ]) {
      assert.ok(expected.test(INLINE_JS), `状态码 ${status} 应有自己的文案`);
    }
  });

  test('请求挂起时 8 秒后给出重试出口', async () => {
    // fetch 永不 resolve 的极端情况（请求被拦、端口转发没建立）：页面不能
    // 永远停在「正在载入…」，用户看不出该重试还是该换浏览器。
    const p = runPage({}, { hang: true });
    await flush();
    assert.equal(p.el('app').innerHTML, '正在载入…', '请求挂着时保持初始状态');
    const bail = p.timers.find((t) => t.ms === 8000);
    assert.ok(bail, '应注册 8 秒自愈定时器');
    bail.fn();
    assert.match(p.el('app').innerHTML, /重试/);
    assert.match(p.el('app').innerHTML, /JavaScript/);
    assert.equal(p.el('app').getAttribute('aria-busy'), 'false');
  });

  test('成功进入后自愈定时器不再触发', async () => {
    const p = runPage({ '/panel/api/session': res(200, { authenticated: false }) });
    await flush();
    const bail = p.timers.find((t) => t.ms === 8000);
    bail.fn();
    assert.match(p.el('app').innerHTML, /API Key/, '已进入登录表单，自愈不得覆盖它');
  });

  test('状态展示：上报 offline 的 Agent 与纠偏一样显示「离线」', async () => {
    const p = runPage({
      '/panel/api/session': res(200, { authenticated: true }),
      '/panel/api/snapshot': res(200, {
        ...SNAPSHOT,
        totals: { ...SNAPSHOT.totals, agents: 2, online: 1 },
        agents: [
          { agentId: 'alive', status: 'online', stale: false, model: null, framework: null,
            source: null, lastSeenAt: 1700000000000, tasks: 0, tokens: 0 },
          { agentId: 'stopped', status: 'offline', stale: false, model: null, framework: null,
            source: null, lastSeenAt: 1700000000000, tasks: 0, tokens: 0 },
        ],
      }),
    });
    await flush();
    await flush();
    const html = p.el('app').innerHTML;
    assert.match(html, /在线/, 'online 的 Agent 显示在线');
    assert.equal((html.match(/离线/g) || []).length >= 2, true,
      '主动上报的 offline 应与纠偏一样按「离线」呈现（含 KPI 提示行）');
    assert.doesNotMatch(html, />offline</, '原文 offline 不得直接出现在状态格里');
  });
});
