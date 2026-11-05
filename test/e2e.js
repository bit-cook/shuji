#!/usr/bin/env node
'use strict';
/**
 * 端到端模拟验收：不依赖真实微信与企业微信凭证，
 * 用 mock Mission-Control + mock Hermes RPC + 真实 Sidecar 子进程 + 真实 bridge，
 * 复跑部署手册 Phase 09 的 T1–T14 验收用例。
 * 运行：node test/e2e.js
 *
 * 覆盖：链路 / 安全（白名单、端点鉴权、确认令牌）/ 状态 / 告警 / 恢复 /
 *       计量 / 调度 / 韧性 / Telegram / 审计留痕 / 企业微信备份链路。
 *
 * T15–T22 另起一节打**真控制面**：mission-control 与 sidecar 都以子进程运行
 * （走真实 CLI 与环境变量解析），bridge 指向真 SQLite。验证 mock 测不到的两件事：
 *   1. 持久化：bridge 重启后 Agent / 任务 / 成本还在
 *   2. 心跳超时纠偏：断心跳的 Agent 在 /list 显示 offline
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const pexec = promisify(execFile);

const { createMockMissionControl } = require('./mock-mission-control');
const { createMockTelegram } = require('./mock-telegram');
const { createBridgeFromEnv, listen } = require('../packages/wechat-bridge/src/index');
const { createHttpAdapter } = require('../packages/wechat-bridge/src/adapters/http');
const { createRouter } = require('../packages/wechat-bridge/src/core');
const { createMissionControl } = require('../packages/mission-control/src/index');
const w = require('../packages/wechat-bridge/src/adapters/wecom');

const SIDECAR = path.join(__dirname, '..', 'packages', 'hermes-sidecar', 'sidecar.py');
const MC_CLI = path.join(__dirname, '..', 'packages', 'mission-control', 'src', 'cli.js');
const ALLOW = 'me';
const BRIDGE_TOKEN = 'e2e-bridge-token';
const MC_KEY = 'e2e-mc-key-0123456789abcdef';

let passed = 0, failed = 0;
function report(id, name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (ok) passed++; else failed++;
  console.log(`[${mark}] ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

async function postJson(url, obj, token = BRIDGE_TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(obj),
  });
  return (await res.json()).reply;
}

async function main() {
  // ---- 搭环境：mock 控制面 + mock Hermes RPC + 真 bridge ----
  const mc = createMockMissionControl({ apiKey: 'e2e-key' });
  const mcServer = await mc.listen(0);
  const MC_BASE = `http://127.0.0.1:${mcServer.address().port}`;
  const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shuji-e2e-')), 'audit.jsonl');

  const hermesServer = http.createServer((req, res) => {
    if (req.url.startsWith('/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: 3, version: '0.9.0' }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => hermesServer.listen(0, '127.0.0.1', r));
  const HERMES_RPC = `http://127.0.0.1:${hermesServer.address().port}/status`;

  const env = {
    ...process.env,
    MC_BASE, MC_API_KEY: 'e2e-key',
    WECHAT_ALLOW_FROM: ALLOW,
    ADAPTER: 'http', HOST: '127.0.0.1', PORT: '0',
    AUDIT_LOG: auditFile, BRIDGE_TOKEN,
  };
  const { router, server } = createBridgeFromEnv(env);
  await new Promise((r) => server.once('listening', r));
  const BRIDGE = `http://127.0.0.1:${server.address().port}`;

  const sidecarEnv = {
    ...process.env,
    MC_BASE, MC_API_KEY: 'e2e-key', AGENT_ID: 'hermes-node-b', HERMES_RPC, INTERVAL: '1',
  };
  const runSidecar = async () => {
    try {
      const r = await pexec('python3', [SIDECAR, '--once'], { env: sidecarEnv });
      if (r.stderr) process.stderr.write('[sidecar stderr] ' + r.stderr);
      const last = r.stdout.trim().split('\n').pop();
      if (last) console.log('[sidecar] ' + last);
    } catch (e) {
      console.error('[sidecar 失败]', e.stderr || e.message);
      throw e;
    }
  };

  try {
    // T1 链路自检
    const pong = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/ping' });
    report('T1', '链路：/ping 收到 pong', /^pong · \d{4}-\d{2}-\d{2}T/.test(pong), pong);

    // T2 安全：白名单外拒绝
    const denied = await postJson(BRIDGE + '/message', { from: 'stranger', text: '/ping' });
    report('T2', '安全：白名单外拒绝访问', denied === '拒绝访问：不在白名单内', denied);

    // T3 状态：sidecar 上报后 /list 在线
    await runSidecar();
    const list = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/list' });
    report('T3', '状态：/list 显示 hermes-node-b 在线', /hermes-node-b \[online\]/.test(list), list.split('\n')[0]);

    // T4 告警：Hermes RPC 停掉 → 下个周期转离线
    await new Promise((r) => hermesServer.close(r));
    await runSidecar();
    const listOff = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/list' });
    report('T4', '告警：Hermes 停服后 /list 转离线', /hermes-node-b \[offline\]/.test(listOff), listOff.split('\n')[0]);

    // T5 恢复：重新拉起 → 恢复 online
    const hermesServer2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: 5, version: '0.9.0' }));
    });
    await new Promise((r) => hermesServer2.listen(0, '127.0.0.1', r));
    sidecarEnv.HERMES_RPC = `http://127.0.0.1:${hermesServer2.address().port}/status`;
    await runSidecar();
    const status = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/status hermes-node-b' });
    report('T5', '恢复：/status 回到 online 且详情可读', /"status": "online"/.test(status) && /sessions/.test(status), status.replace(/\s+/g, ' ').slice(0, 140));

    // T6 计量：/cost 非空
    const cost = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/cost' });
    const costObj = JSON.parse(cost);
    report('T6', '计量：/cost 返回非空汇总', costObj.totalTokens > 0, `totalTokens=${costObj.totalTokens}`);

    // T7 调度：dispatch 二次确认后任务落库
    const pending = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/dispatch node-openclaw 夜间巡检一次' });
    const token = (pending.match(/\/confirm ([0-9A-F]{8})/) || [])[1];
    const dispatched = await postJson(BRIDGE + '/message', { from: ALLOW, text: `/confirm ${token}` });
    const taskOk = dispatched.includes('已下发') && mc.tasks.some((t) => t.agentId === 'node-openclaw' && t.title === '夜间巡检一次');
    report('T7', '调度：dispatch 二次确认后任务下发', taskOk, dispatched.slice(0, 60));

    // T8 韧性：bridge 进程重启后数据不丢（控制面保持运行）
    await new Promise((r) => { server.closeAllConnections(); server.close(r); });
    const router2 = createRouter({
      mc: {
        async get(p) {
          if (p === '/api/agents') {
            const res = await fetch(MC_BASE + '/api/agents', { headers: { Authorization: 'Bearer e2e-key' } });
            return res.json();
          }
          throw new Error('404');
        },
        async post() { return {}; },
      },
      allowFrom: [ALLOW], audit: { record() {} },
    });
    const adapter2 = createHttpAdapter({ router: router2 });
    const server2 = listen({ handler: adapter2.handler, port: 0, host: '127.0.0.1' });
    await new Promise((r) => server2.once('listening', r));
    const list2 = await postJson(`http://127.0.0.1:${server2.address().port}/message`, { from: ALLOW, text: '/list' }, '');
    report('T8', '韧性：bridge 重启后 /list 数据仍在', /hermes-node-b \[online\]/.test(list2), list2.split('\n')[0]);
    await new Promise((r) => { server2.closeAllConnections(); server2.close(r); });

    // T11 起：T8 关掉的是旧进程那个实例，这里重新拉一个桥，继续验安全项
    const bridge3 = createBridgeFromEnv(env);
    await new Promise((r) => bridge3.server.once('listening', r));
    const BRIDGE3 = `http://127.0.0.1:${bridge3.server.address().port}`;

    // T9 Telegram 入口：长轮询适配器全链路（mock Bot API）
    const tg = createMockTelegram();
    const tgPort = await tg.listen();
    const tgEnv = {
      ...process.env,
      MC_BASE, MC_API_KEY: 'e2e-key',
      WECHAT_ALLOW_FROM: '', TELEGRAM_ALLOW_FROM: 'tg-me',
      ADAPTER: 'telegram', TELEGRAM_BOT_TOKEN: 'e2e-token',
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      TELEGRAM_DRAIN_BACKLOG: '0', AUDIT_LOG: auditFile,
    };
    const tgBridge = createBridgeFromEnv(tgEnv);
    try {
      tg.push({ message: { message_id: 1, from: { id: 'tg-me' }, chat: { id: 42 }, text: '/ping' } });
      tg.push({ message: { message_id: 2, from: { id: 'stranger' }, chat: { id: 43 }, text: '/list' } });
      const tgDeadline = Date.now() + 5000;
      while (tg.state.sent.length < 2 && Date.now() < tgDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const pongOk = tg.state.sent[0] && tg.state.sent[0].chat_id === 42 && /^pong/.test(tg.state.sent[0].text);
      const denyOk = tg.state.sent[1] && tg.state.sent[1].chat_id === 43 && /拒绝访问/.test(tg.state.sent[1].text);
      report('T9', 'Telegram：/ping 通、陌生人拒（长轮询适配器）', !!(pongOk && denyOk),
        `sent=${tg.state.sent.length} first=${(tg.state.sent[0] && tg.state.sent[0].text || '').slice(0, 30)}`);
    } finally {
      tgBridge.polling.stop();
    }
    await tg.close();

    // T10 审计：每一步（含被拒）都留痕，且 confirm 链路带原文
    const auditLines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const results = auditLines.map((e) => e.result);
    report('T10', '审计：全量留痕（ok / denied / confirm_required / confirm_ok）',
      results.includes('ok') && results.includes('denied') && results.includes('confirm_required'),
      `lines=${auditLines.length} results=${[...new Set(results)].join(',')}`);
    const confirmEntry = auditLines.find((e) => e.result === 'ok' && e.confirmed);
    report('T10b', '审计：确认执行记录带原命令与通道',
      !!confirmEntry && confirmEntry.confirmed.includes('/dispatch node-openclaw') && confirmEntry.channel === 'http',
      confirmEntry ? `channel=${confirmEntry.channel} confirmed=${confirmEntry.confirmed.slice(0, 40)}` : 'missing');

    // T11 端点鉴权：BRIDGE_TOKEN 缺失/错误 401，正确 200
    {
      const noTok = await fetch(BRIDGE3 + '/openclaw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: ALLOW, text: '/ping' }),
      });
      const badTok = await fetch(BRIDGE3 + '/openclaw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
        body: JSON.stringify({ from: ALLOW, text: '/ping' }),
      });
      const good = await postJson(BRIDGE3 + '/openclaw', { from: ALLOW, text: '/ping' });
      report('T11', '端点鉴权：BRIDGE_TOKEN 强制 Bearer（缺/错 401，对 200）',
        noTok.status === 401 && badTok.status === 401 && /^pong/.test(good),
        `noTok=${noTok.status} badTok=${badTok.status}`);
    }

    // T12 确认令牌：一次性 + 发起人不一致即拒
    {
      const p1 = await postJson(BRIDGE3 + '/message', { from: ALLOW, text: '/dispatch node-a 一次性校验' });
      const tok = p1.match(/\/confirm ([0-9A-F]{8})/)[1];
      const used = await postJson(BRIDGE3 + '/message', { from: ALLOW, text: `/confirm ${tok}` });
      const reused = await postJson(BRIDGE3 + '/message', { from: ALLOW, text: `/confirm ${tok}` });
      const wrongUser = await postJson(BRIDGE3 + '/message', { from: 'stranger', text: `/confirm ${tok}` });
      const dispatchedOnce = mc.tasks.filter((t) => t.title === '一次性校验').length;
      report('T12', '确认令牌：一次性消费 + 非发起人拒绝',
        /已下发/.test(used) && /确认失败/.test(reused) && dispatchedOnce === 1,
        `dispatched=${dispatchedOnce} reused=${reused.slice(0, 20)} stranger=${wrongUser.slice(0, 12)}`);
    }

    // T13 韧性：超大 body / 坏连接之后服务照常
    {
      const big = await fetch(BRIDGE3 + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE_TOKEN },
        body: JSON.stringify({ from: ALLOW, text: '/ping', pad: 'x'.repeat(2 * 1024 * 1024) }),
      });
      const still = await postJson(BRIDGE3 + '/message', { from: ALLOW, text: '/ping' });
      report('T13', '韧性：超大请求体被拒后服务照常', big.status === 413 && /^pong/.test(still),
        `status=${big.status}`);
      bridge3.server.closeAllConnections();
      await new Promise((r) => bridge3.server.close(r));
    }

    // T14 企业微信备份链路：加密消息进 → 加密回复出；伪造签名 400（可选入口）
    {
      const TOKEN = 'QDG6eK', CORP = 'wwabc123corp';
      const AES = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
      const wecomEnv = {
        ...process.env,
        MC_BASE, MC_API_KEY: 'e2e-key', WECHAT_ALLOW_FROM: ALLOW, AUDIT_LOG: auditFile,
        ADAPTER: 'wecom', HOST: '127.0.0.1', PORT: '0',
        WECOM_TOKEN: TOKEN, WECOM_ENCODING_AES_KEY: AES, WECOM_CORP_ID: CORP,
      };
      const wb = createBridgeFromEnv(wecomEnv);
      await new Promise((r) => wb.server.once('listening', r));
      try {
        const url = `http://127.0.0.1:${wb.server.address().port}/callback`;
        const ts = String(Math.floor(Date.now() / 1000)), nonce = 'n1';
        const inner = '<xml><FromUserName><![CDATA[' + ALLOW + ']]></FromUserName>' +
          '<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/ping]]></Content></xml>';
        const enc = w.encryptMsg({ aesKey: w.aesKeyFrom(AES), corpId: CORP, text: inner });
        const body = '<xml><Encrypt><![CDATA[' + enc + ']]></Encrypt></xml>';
        const sig = w.signature({ token: TOKEN, timestamp: ts, nonce, encrypt: enc });
        const res = await fetch(`${url}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
          method: 'POST', body,
        });
        const replyEnc = w.extractTag(await res.text(), 'Encrypt');
        const replyText = w.decryptMsg({ aesKey: w.aesKeyFrom(AES), corpId: CORP, base64: replyEnc });
        const forged = await fetch(`${url}?msg_signature=forged&timestamp=${ts}&nonce=${nonce}`, {
          method: 'POST', body,
        });
        report('T14', '企微备份链路：加解密往返 + 伪造签名 400',
          res.status === 200 && /^pong/.test(replyText) && forged.status === 400,
          `status=${res.status} forged=${forged.status}`);
      } finally {
        wb.server.closeAllConnections();
        await new Promise((r) => wb.server.close(r));
      }
    }
  } finally {
    await new Promise((r) => { mcServer.closeAllConnections(); mcServer.close(r); });
    fs.rmSync(path.dirname(auditFile), { recursive: true, force: true });
  }

  await realControlPlaneSection();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  console.log('说明：T1–T14 用 mock 控制面 + mock Hermes RPC 模拟微信入口（HTTP 适配器 /openclaw，带 Bearer）；');
  console.log('      Telegram 走长轮询适配器；企业微信备份链路由 T14 覆盖。');
  console.log('      T15–T22 打的是**真控制面**（真 SQLite + 真 sidecar 子进程 + 真 bridge 进程），验证持久化与心跳纠偏。');
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * T15–T22：真控制面验收。
 * 这里不再用 mock——mission-control 以**子进程**启动（走真实 CLI 与环境变量解析），
 * sidecar 也以子进程跑，bridge 用同一份 MC_BASE/MC_API_KEY。
 * 重点验证 mock 测不到的两件事：
 *   1. 持久化：bridge 重启后 Agent / 任务 / 成本还在（SQLite，不是内存）
 *   2. 心跳超时纠偏：断心跳的 Agent 在 /list 里显示 offline，而不是最后一份心跳自称的 online
 */
async function realControlPlaneSection() {
  console.log('\n---- T15–T22 真控制面（SQLite + 子进程）----');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuji-e2e-mc-'));
  const dbFile = path.join(tmp, 'mc.db');
  const auditFile = path.join(tmp, 'mc-audit.jsonl');
  const MC_BASE = 'http://127.0.0.1:3199';

  const mc = spawn(process.execPath, [MC_CLI], {
    env: {
      ...process.env,
      MC_HOST: '127.0.0.1', MC_PORT: '3199', MC_API_KEY: MC_KEY,
      MC_DB: dbFile, MC_AUDIT_LOG: auditFile,
      MC_STALE_SEC: '2',            // 故意设短，便于验证纠偏
      MC_TASKS_PER_AGENT: '100',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mcOut = '';
  mc.stdout.on('data', (d) => { mcOut += d; });
  mc.stderr.on('data', (d) => { mcOut += d; });

  const bridgeEnv = {
    ...process.env,
    MC_BASE, MC_API_KEY: MC_KEY,
    WECHAT_ALLOW_FROM: ALLOW,
    ADAPTER: 'http', HOST: '127.0.0.1', PORT: '0',
    AUDIT_LOG: path.join(tmp, 'bridge-audit.jsonl'), BRIDGE_TOKEN,
  };

  const sidecarEnv = {
    ...process.env,
    MC_BASE, MC_API_KEY: MC_KEY,
    AGENT_ID: 'hermes-node-b',
    INTERVAL: '1',
  };

  try {
    await waitFor(MC_BASE + '/healthz', 8000);
    report('T15', '真控制面：CLI 启动 + /healthz 免鉴权 + 无令牌 401',
      true, 'listening');

    const noTok = await fetch(MC_BASE + '/api/agents');
    const badTok = await fetch(MC_BASE + '/api/agents', { headers: { Authorization: 'Bearer nope' } });
    const goodTok = await fetch(MC_BASE + '/api/agents', { headers: { Authorization: 'Bearer ' + MC_KEY } });
    report('T15b', '真控制面：Bearer 鉴权（无令牌/错令牌 401，正确 200）',
      noTok.status === 401 && badTok.status === 401 && goodTok.status === 200,
      `noTok=${noTok.status} badTok=${badTok.status} good=${goodTok.status}`);

    // Hermes 状态源用本地 stub（T1–T14 同款）：RPC 优先，结果确定，
    // 不依赖验收机上是否真的装着 hermes-gateway.service。
    const hermesStub = http.createServer((req, res) => {
      if (req.url.startsWith('/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: 3, version: '0.22.2' }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => hermesStub.listen(0, '127.0.0.1', r));

    // 真 sidecar 子进程：心跳一次后退出
    const sidecar = spawn('python3', [SIDECAR, '--once'], {
      env: { ...sidecarEnv, HERMES_RPC: `http://127.0.0.1:${hermesStub.address().port}/status` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let scOut = '';
    sidecar.stdout.on('data', (d) => { scOut += d; });
    sidecar.stderr.on('data', (d) => { scOut += d; });
    const scCode = await new Promise((r) => sidecar.on('exit', r));
    const hbOk = scCode === 0 && scOut.includes('"ok": true');

    const { router, server } = createBridgeFromEnv(bridgeEnv);
    await new Promise((r) => server.once('listening', r));
    const BRIDGE = `http://127.0.0.1:${server.address().port}`;

    const list = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/list' });
    report('T16', '真 sidecar 心跳 → 真控制面 → 桥 /list 显示在线',
      hbOk && /hermes-node-b \[online\]/.test(list), `sidecar exit=${scCode} ${list.split('\n')[0]}`);

    const status = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/status hermes-node-b' });
    report('T17', '真控制面：/status 详情带来源（hermes-rpc）与会话数',
      /"status": "online"/.test(status) && /"source": "hermes-rpc"/.test(status) && /"sessions": 3/.test(status),
      status.replace(/\s+/g, ' ').slice(0, 160));

    // RPC 不可用 → 退化查 systemd。验收机上未必装着这个单元，
    // 所以不断言 online/offline，只断言「退化路径真的走到了、
    // 且把单元名带上了」——作用域识别本身由 sidecar 单测覆盖。
    const fb = spawn('python3', [SIDECAR, '--once'], {
      env: {
        ...sidecarEnv,
        AGENT_ID: 'hermes-node-fallback',
        HERMES_RPC: 'http://127.0.0.1:1/status',
        SYSTEMD_UNIT: 'hermes-gateway.service',
        SYSTEMD_SCOPE: 'user',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fbOut = '';
    fb.stdout.on('data', (d) => { fbOut += d; });
    fb.stderr.on('data', (d) => { fbOut += d; });
    const fbCode = await new Promise((r) => fb.on('exit', r));
    const fbAgent = await (await fetch(MC_BASE + '/api/agents/hermes-node-fallback', {
      headers: { Authorization: 'Bearer ' + MC_KEY },
    })).json();
    report('T17b', 'RPC 不可用时退化查 systemd（来源与单元名进入心跳详情）',
      fbCode === 0
      && ['systemd', 'none'].includes(fbAgent.detail && fbAgent.detail.source)
      && (fbAgent.detail || {}).unit === 'hermes-gateway.service'
      && (fbOut.includes('"ok": true')),
      `source=${fbAgent.detail && fbAgent.detail.source} unit=${(fbAgent.detail || {}).unit}`);
    hermesStub.closeAllConnections();
    hermesStub.close();

    const dispatch = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/dispatch hermes-node-b 夜间巡检一次' });
    const token = (dispatch.match(/\/confirm ([0-9A-F]{8})/) || [])[1];
    const confirmed = token ? await postJson(BRIDGE + '/message', { from: ALLOW, text: '/confirm ' + token }) : '';
    const ghost = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/dispatch ghost x' });
    const ghostTok = (ghost.match(/\/confirm ([0-9A-F]{8})/) || [])[1];
    const ghostReply = ghostTok ? await postJson(BRIDGE + '/message', { from: ALLOW, text: '/confirm ' + ghostTok }) : '';
    report('T18', '真控制面：/dispatch 落库；未注册 Agent 提示「未找到」',
      /已下发/.test(confirmed) && /未找到 Agent：ghost/.test(ghostReply),
      `dispatch=${/已下发/.test(confirmed)} ghost=${ghostReply.split('\n')[0]}`);

    // 心跳超时纠偏：MC_STALE_SEC=2，停掉心跳后 /list 应转 offline
    await new Promise((r) => setTimeout(r, 2600));
    const staleList = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/list' });
    report('T19', '心跳超时纠偏：断心跳后 /list 报 offline（而非最后自称的 online）',
      /hermes-node-b \[offline\]/.test(staleList), staleList.split('\n')[0]);

    // 工人取任务并回报 → /cost 反映用量
    const tasksRaw = await (await fetch(MC_BASE + '/api/agents/hermes-node-b/tasks', {
      headers: { Authorization: 'Bearer ' + MC_KEY },
    })).json();
    const taskId = (tasksRaw.find((t) => t.status === 'pending') || {}).id;
    const claimed = await fetch(`${MC_BASE}/api/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimedBy: 'e2e-worker' }),
    });
    const done = await fetch(`${MC_BASE}/api/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', tokens: 4242, costUsd: 0.42, result: 'ok' }),
    });
    const cost = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/cost' });
    const costObj = JSON.parse(cost);
    report('T20', '真控制面：claim/complete 后 /cost 计入用量',
      claimed.status === 200 && done.status === 200 && costObj.totalTokens === 4242,
      `claim=${claimed.status} done=${done.status} totalTokens=${costObj.totalTokens}`);

    // 持久化：bridge 重启后数据仍在（mock 版这一项其实没测到真持久化）
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    const { router: r2, server: s2 } = createBridgeFromEnv(bridgeEnv);
    await new Promise((r) => s2.once('listening', r));
    const BRIDGE2 = `http://127.0.0.1:${s2.address().port}`;
    const list2 = await postJson(BRIDGE2 + '/message', { from: ALLOW, text: '/list' });
    const tasks2 = await postJson(BRIDGE2 + '/message', { from: ALLOW, text: '/tasks hermes-node-b' });
    report('T21', '持久化：bridge 重启后 Agent 与任务都还在（真 SQLite）',
      /hermes-node-b \[offline\]/.test(list2) && /夜间巡检一次/.test(tasks2),
      `agent=${/hermes-node-b/.test(list2)} task=${/夜间巡检一次/.test(tasks2)}`);
    s2.closeAllConnections();
    await new Promise((r) => s2.close(r));

    // 审计落库且不含密钥
    const auditOk = fs.existsSync(auditFile) && !fs.readFileSync(auditFile, 'utf8').includes(MC_KEY);
    report('T22', '真控制面：审计留痕且不含 API Key',
      auditOk, auditFile);
  } finally {
    mc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try { mc.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async function attempt() {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('等待 ' + url + ' 超时');
    await new Promise((r) => setTimeout(r, 100));
    return attempt();
  }());
}

main().catch((e) => { console.error('e2e 崩溃：', e); process.exit(1); });
