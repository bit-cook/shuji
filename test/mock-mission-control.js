#!/usr/bin/env node
'use strict';
/**
 * Mission-Control 测试桩（仅用于本地验收，不是产品）。
 * 实现命令路由用到的 REST 子集 + generic 心跳协议：
 *   GET  /api/agents                全部 Agent
 *   GET  /api/agents/<id>           单个 Agent（404 若未注册）
 *   GET  /api/agents/<id>/tasks     最近任务
 *   GET  /api/costs/summary         成本汇总
 *   POST /api/agents/heartbeat      generic 协议注册/更新
 *   POST /api/tasks                 下发任务
 * Bearer <MC_API_KEY> 鉴权，401 若非空 key 不匹配。
 */
const http = require('node:http');

function createMockMissionControl({ apiKey = 'test-key', now = () => Date.now() } = {}) {
  const agents = new Map();
  const tasks = [];
  const costs = { totalTokens: 1234567, totalCostUsd: 12.34, byAgent: {} };

  function auth(req) {
    if (!apiKey) return true;
    return req.headers.authorization === 'Bearer ' + apiKey;
  }

  const routes = {
    'GET /api/agents': () => ({ status: 200, body: [...agents.values()] }),
    'GET /api/agents/:id': (m) => {
      const a = agents.get(m[0]);
      if (!a) return { status: 404, body: { message: 'not found' } };
      return { status: 200, body: a };
    },
    'GET /api/agents/:id/tasks': (m) => ({ status: 200, body: tasks.filter((t) => t.agentId === m[0]) }),
    'GET /api/costs/summary': () => ({ status: 200, body: costs }),
    'POST /api/agents/heartbeat': (m, body) => {
      const p = (body && body.payload) || {};
      const id = p.agentId || 'unknown';
      const prev = agents.get(id) || { agentId: id, model: 'hermes-cli', framework: 'generic' };
      agents.set(id, {
        ...prev,
        status: p.status || 'unknown',
        lastSeenAt: p.reportedAt || now(),
        detail: p.detail || {},
      });
      return { status: 200, body: { ok: true, agentId: id } };
    },
    'POST /api/tasks': (m, body) => {
      const task = { id: 'task-' + (tasks.length + 1), ...body, acceptedAt: now() };
      tasks.push(task);
      return { status: 200, body: { ok: true, task } };
    },
  };

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (!auth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"message":"unauthorized"}');
      return;
    }
    let matched = null;
    const key = req.method + ' ' + path;
    if (routes[key]) matched = { fn: routes[key], m: [] };
    if (!matched) {
      for (const rk of Object.keys(routes)) {
        const [m0, ...segs] = rk.split(' ');
        if (m0 !== req.method) continue;
        const rp = segs.join(' ').split('/');
        const pp = path.split('/');
        if (rp.length !== pp.length) continue;
        const params = [];
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
          if (rp[i].startsWith(':')) params.push(decodeURIComponent(pp[i]));
          else if (rp[i] !== pp[i]) { ok = false; break; }
        }
        if (ok) { matched = { fn: routes[rk], m: params }; break; }
      }
    }
    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"no route ' + key + '"}');
      return;
    }
    let body = null;
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        const out = matched.fn(matched.m, body);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    const out = matched.fn(matched.m, null);
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }

  return {
    handler,
    agents,
    tasks,
    costs,
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(port, host, () => resolve(server));
      }),
  };
}

if (require.main === module) {
  const port = Number(process.argv[2] || 3000);
  const apiKey = process.env.MC_API_KEY || 'test-key';
  createMockMissionControl({ apiKey }).listen(port).then((s) => {
    process.stdout.write(`mock mission-control listening on http://127.0.0.1:${s.address().port} (key=${apiKey})\n`);
  });
}

module.exports = { createMockMissionControl };
