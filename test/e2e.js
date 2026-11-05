#!/usr/bin/env node
'use strict';
/**
 * 端到端模拟验收：不依赖真实微信与企业微信凭证，
 * 用 mock Mission-Control + mock Hermes RPC + 真实 Sidecar 子进程 + 真实 bridge，
 * 复跑部署手册 Phase 09 的 T1–T8 验收用例。
 * 运行：node test/e2e.js
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const pexec = promisify(execFile);

const { createMockMissionControl } = require('./mock-mission-control');
const { createMockTelegram } = require('./mock-telegram');
const { createBridgeFromEnv, listen } = require('../packages/wechat-bridge/src/index');
const { createHttpAdapter } = require('../packages/wechat-bridge/src/adapters/http');
const { createRouter } = require('../packages/wechat-bridge/src/core');

const SIDECAR = path.join(__dirname, '..', 'packages', 'hermes-sidecar', 'sidecar.py');
const ALLOW = 'me';

let passed = 0, failed = 0;
function report(id, name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (ok) passed++; else failed++;
  console.log(`[${mark}] ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

async function postJson(url, obj) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
  });
  return (await res.json()).reply;
}

async function main() {
  // ---- 搭环境：mock 控制面 + mock Hermes RPC + 真 bridge ----
  const mc = createMockMissionControl({ apiKey: 'e2e-key' });
  const mcServer = await mc.listen(0);
  const MC_BASE = `http://127.0.0.1:${mcServer.address().port}`;

  let hermesUp = true;
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
    hermesUp = false;
    await new Promise((r) => hermesServer.close(r));
    await runSidecar();
    const listOff = await postJson(BRIDGE + '/message', { from: ALLOW, text: '/list' });
    report('T4', '告警：Hermes 停服后 /list 转离线', /hermes-node-b \[offline\]/.test(listOff), listOff.split('\n')[0]);

    // T5 恢复：重新拉起 → 恢复 online
    hermesUp = true;
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
    await new Promise((r) => server.close(r));
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
    const list2 = await postJson(`http://127.0.0.1:${server2.address().port}/message`, { from: ALLOW, text: '/list' });
    report('T8', '韧性：bridge 重启后 /list 数据仍在', /hermes-node-b \[online\]/.test(list2), list2.split('\n')[0]);
    await new Promise((r) => { server2.closeAllConnections(); server2.close(r); });

    // T9 Telegram 入口：长轮询适配器全链路（mock Bot API）
    const tg = createMockTelegram();
    const tgPort = await tg.listen();
    const tgEnv = {
      ...process.env,
      MC_BASE, MC_API_KEY: 'e2e-key',
      WECHAT_ALLOW_FROM: '', TELEGRAM_ALLOW_FROM: 'tg-me',
      ADAPTER: 'telegram', TELEGRAM_BOT_TOKEN: 'e2e-token',
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      TELEGRAM_DRAIN_BACKLOG: '0',
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
  } finally {
    await new Promise((r) => { mcServer.closeAllConnections(); mcServer.close(r); });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  console.log('说明：本验收用 mock 控制面 + mock Hermes RPC 模拟微信入口（HTTP 适配器）；');
  console.log('真实企业微信回调路径由 packages/wechat-bridge/test/wecom-crypto.test.js 的真服务器加解密测试覆盖。');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('e2e 崩溃：', e); process.exit(1); });
