/**
 * 控制面进程内计数器：请求吞吐 / 未授权 / 限流 / 错误 / 心跳与任务事件。
 * 只增不减、重启清零（SQLite 才是持久真相，这里只为运维观察）。
 * 经 /statsz 暴露；测试可注入 now 冻结 startedAt。
 *
 * byRoute / byStatus 的键有一部分来自**请求本身**（未命中路由时用的是完整 path，
 * 最长 512 字节，且这一步发生在鉴权之前）。不设上限的话，扫端口的流量就能把
 * 这张 Map 撑到无界，而 /statsz 是免鉴权的——等于把注入的字符串又读回去。
 * 所以这里对键的数量设硬上限，超出部分归入一个聚合桶。
 */
const MAX_ROUTE_KEYS = 64;

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
    routeKeysDropped: 0, // 因超出键上限被归并的路径种类数
  };
  const seenAgents = new Set();

  function bump(field, n = 1) {
    s[field] = (s[field] || 0) + n;
  }

  /** 有界计数：键太多时归并到 *other，防止 Map 无界增长。 */
  function bumpKey(map, key, limit, droppedField) {
    const k = String(key || '?');
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      map[k] += 1;
      return;
    }
    // 给聚合桶预留一个名额：否则第一次归并时键数会冲到 limit+1，上限就没守住。
    const hasOther = Object.prototype.hasOwnProperty.call(map, '*other');
    const room = Math.max(0, limit - (hasOther ? 1 : 2));
    if (Object.keys(map).length <= room) {
      map[k] = 1;
      return;
    }
    if (droppedField) s[droppedField] = (s[droppedField] || 0) + 1;
    map['*other'] = (map['*other'] || 0) + 1;
  }

  return {
    raw: s,
    bump,
    /** 一次请求的生命周期记账：route = 'GET /api/agents' */
    request(route, status) {
      s.requests += 1;
      bumpKey(s.byRoute, route, MAX_ROUTE_KEYS, 'routeKeysDropped');
      bumpKey(s.byStatus, status, 64);
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

module.exports = { createStats, MAX_ROUTE_KEYS };
