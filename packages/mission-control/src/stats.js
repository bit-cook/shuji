'use strict';
/**
 * 控制面进程内计数器：请求吞吐 / 未授权 / 限流 / 错误 / 心跳与任务事件。
 * 只增不减、重启清零（SQLite 才是持久真相，这里只为运维观察）。
 * 经 /statsz 暴露；测试可注入 now 冻结 startedAt。
 */
function createStats({ now = () => Date.now() } = {}) {
  const s = {
    startedAt: now(),
    requests: 0,        // 进入 HTTP 层的请求总数（含探针）
    ok: 0,              // 2xx
    clientErrors: 0,    // 4xx（含未授权 / 限流 / 404）
    serverErrors: 0,    // 5xx
    unauthorized: 0,
    rateLimited: 0,
    heartbeats: 0,      // 心跳上报次数（含重复）
    agentsSeen: 0,      // 出现过的心跳 agentId 去重数
    tasksCreated: 0,
    tasksClaimed: 0,
    tasksCompleted: 0,
    byRoute: {},        // { 'GET /api/agents': 3, ... }
    byStatus: {},       // { '200': 12, '404': 1, ... }
  };
  const seenAgents = new Set();

  function bump(field, n = 1) {
    s[field] = (s[field] || 0) + n;
  }

  return {
    raw: s,
    bump,
    /** 一次请求的生命周期记账：route = 'GET /api/agents' */
    request(route, status) {
      s.requests += 1;
      const rk = String(route || '?');
      s.byRoute[rk] = (s.byRoute[rk] || 0) + 1;
      const sk = String(status || '?');
      s.byStatus[sk] = (s.byStatus[sk] || 0) + 1;
      if (status >= 200 && status < 300) s.ok += 1;
      else if (status >= 500) s.serverErrors += 1;
      else if (status >= 400) s.clientErrors += 1;
    },
    heartbeat(agentId) {
      s.heartbeats += 1;
      if (agentId && !seenAgents.has(String(agentId))) {
        seenAgents.add(String(agentId));
        s.agentsSeen = seenAgents.size;
      }
    },
    snapshot() {
      const upMs = now() - s.startedAt;
      return { ...s, byRoute: { ...s.byRoute }, byStatus: { ...s.byStatus }, uptimeSec: Math.floor(upMs / 1000) };
    },
  };
}

module.exports = { createStats };
