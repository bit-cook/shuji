'use strict';
/**
 * 控制面持久层（node:sqlite，Node 22.5+ / 24 无需 flag）。
 *
 * 表：
 *   agents     — 心跳注册的 Agent（含累计 token/成本）
 *   tasks      — 下发的任务与生命周期（pending → running → done|failed）
 *   heartbeats — 心跳流水（用于排查「为什么面板说离线」）
 *
 * 设计取舍：
 *   - 读路径计算「有效状态」：超过 staleSec 未心跳的 Agent 一律按 offline 呈现，
 *     否则面板会把早已死掉的 Agent 显示成 online（最后一份心跳是它自己报的）
 *   - 写路径只认明确的状态跃迁，重复 claim / complete 返回可读原因而不是静默成功
 *   - 任务按 Agent 保留上限裁剪，避免长期运行把库撑大
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

let sqlite;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agentId      TEXT PRIMARY KEY,
  framework    TEXT NOT NULL DEFAULT 'generic',
  model        TEXT,
  status       TEXT NOT NULL DEFAULT 'unknown',
  tokens       INTEGER NOT NULL DEFAULT 0,
  costUsd      REAL    NOT NULL DEFAULT 0,
  lastSeenAt   INTEGER,
  detail       TEXT    NOT NULL DEFAULT '{}',
  registeredAt INTEGER NOT NULL,
  updatedAt    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  agentId     TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  createdAt   INTEGER NOT NULL,
  claimedAt   INTEGER,
  completedAt INTEGER,
  claimedBy   TEXT,
  result      TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0,
  costUsd     REAL    NOT NULL DEFAULT 0,
  titleTruncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_agent   ON tasks(agentId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status, createdAt);
CREATE TABLE IF NOT EXISTS heartbeats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId    TEXT NOT NULL,
  status     TEXT NOT NULL,
  reportedAt INTEGER NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_hb_agent ON heartbeats(agentId, reportedAt DESC);
`;

/** 轻量迁移：给旧库补上后加的列（幂等，重复执行不报错）。 */
const MIGRATIONS = [
  ['tasks', 'titleTruncated', 'INTEGER NOT NULL DEFAULT 0'],
];

const TASK_STATUS = new Set(['pending', 'running', 'done', 'failed', 'cancelled']);
const OPEN_STATUS = new Set(['pending', 'running']);

function sqliteAvailable() {
  return !!sqlite;
}

function openDatabase(dbPath) {
  if (!sqlite) {
    throw new Error(
      '当前 Node 无 node:sqlite（需要 Node 22.5+，或 Node 24）。' +
      `当前版本 ${process.version}。控制面必须持久化，拒绝退化为内存存储。`,
    );
  }
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // 数据库里是 Agent 明细与任务标题（可能含机密），权限收到 0600。
  // 目录级 750 是另一道防线，但「目录权限哪天被放宽了」不该顺带把数据送出去。
  // WAL  pragma 一执行就会生成 -wal / -shm，所以放在这三行之后一起收。
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.chmodSync(f, 0o600); } catch { /* 文件不存在或无权改：忽略 */ }
  }
  for (const [table, column, decl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }
  return db;
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function nonNegInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function nonNegFloat(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * 上报时间统一成毫秒。
 * generic 协议的 reportedAt 是 **秒**（sidecar 发 int(time.time())），
 * 而 Node 侧 Date.now() 是毫秒——不换算的话「心跳超时纠偏」会把刚上报的
 * Agent 立刻判成离线（差值天文数字）。1e11 毫秒≈1973 年，1e11 秒≈5138 年，
 * 因此小于 1e11 的一律按秒解读。
 */
function toMillis(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e11 ? Math.floor(n * 1000) : Math.floor(n);
}

/**
 * 心跳 usage 的语义是**增量**（自上次心跳以来新增的 tokens / costUsd），
 * 控制面把它累加进 Agent 的累计值。
 *
 * 这不是唯一合理的读法，所以在这里写清楚：如果一个 Agent 改成上报
 * 「到目前为止的总量」（累计值），成本会被反复累加而无限膨胀，且看不出异常。
 * 要报累计量的 Agent 请自行做差，或先扩展协议（例如加一个 usageMode 字段）。
 */
const USAGE_SEMANTICS = 'delta';

function newTaskId(now, rand = crypto.randomBytes) {
  // 随机部分用 crypto 而不是 Math.random：任务 ID 是 claim/complete 的「口令」，
  // Math.random 的种子可预测，等于把任务领取权交给能观察 ID 序列的人。
  // 这两个端点虽然都要求 Bearer MC_API_KEY，但没有理由在这里用弱随机。
  return 'task-' + now.toString(36) + '-' + rand(3).toString('hex');
}

/**
 * 归一化心跳报文：兼容 generic 协议包装与裸字段两种写法。
 * 返回 { agentId, status, reportedAt, framework, model, detail, usage } 或 null。
 *
 * maxDetailBytes：detail 的大小上限。心跳是周期性自动上报的，一个失灵的 Agent
 * （或恶意的）每周期塞进一大坨 JSON，就能把库撑爆——而控制面是要长期常驻的。
 * 超限时保留可读的摘要而不是整条拒绝：拒绝会让 Agent 直接掉线，更糟。
 * status / model / framework 同理按长度截断（上限见 HEARTBEAT_FIELD_LIMITS）：
 * detail 有 cap 而这几个字段没有的话，每周期一份的大字符串照样能撑爆库。
 */
const HEARTBEAT_FIELD_LIMITS = { agentId: 200, status: 128, model: 128, framework: 64 };

function capField(v, limit) {
  const s = String(v ?? '').trim();
  return s.length > limit ? s.slice(0, limit) : s;
}

function normalizeHeartbeat(body, maxDetailBytes = 8192) {
  if (!body || typeof body !== 'object') return null;
  const p = (body.payload && typeof body.payload === 'object') ? body.payload : body;
  const agentId = capField(p.agentId ?? p.agent_id ?? p.id, HEARTBEAT_FIELD_LIMITS.agentId);
  if (!agentId) return null;
  const detail = (p.detail && typeof p.detail === 'object') ? p.detail : {};
  const usageSrc = (p.usage && typeof p.usage === 'object') ? p.usage
    : (detail.usage && typeof detail.usage === 'object') ? detail.usage : null;
  return {
    agentId,
    status: capField(p.status ?? 'unknown', HEARTBEAT_FIELD_LIMITS.status) || 'unknown',
    reportedAt: toMillis(p.reportedAt ?? p.reported_at ?? p.lastSeenAt, 0) || null,
    framework: capField(body.framework ?? p.framework ?? 'generic', HEARTBEAT_FIELD_LIMITS.framework) || 'generic',
    model: capField(p.model ?? detail.model ?? '', HEARTBEAT_FIELD_LIMITS.model) || null,
    detail: capDetail(detail, maxDetailBytes),
    usage: usageSrc ? {
      tokens: nonNegInt(usageSrc.tokens, 0),
      costUsd: nonNegFloat(usageSrc.costUsd, 0),
    } : null,
  };
}

/** detail 超限时截成摘要；返回的仍是对象（调用方直接 JSON.stringify）。 */
function capDetail(detail, maxBytes) {
  const limit = Number(maxBytes);
  if (!(limit > 0)) return detail;
  let text = JSON.stringify(detail);
  if (Buffer.byteLength(text) <= limit) return detail;
  // 逐键丢弃，优先保留小字段；实在放不下就给摘要
  const kept = {};
  let bytes = 2; // {} 的余量
  for (const [k, v] of Object.entries(detail)) {
    let piece;
    try { piece = JSON.stringify(k) + ':' + JSON.stringify(v); } catch { continue; }
    const cost = Buffer.byteLength(piece) + 1;
    if (bytes + cost > limit) continue;
    kept[k] = v;
    bytes += cost;
  }
  text = JSON.stringify(kept);
  if (Buffer.byteLength(text) <= limit) {
    return { ...kept, _detailTruncated: true, _detailBytes: Buffer.byteLength(JSON.stringify(detail)) };
  }
  return { _detailTruncated: true, _detailBytes: Buffer.byteLength(JSON.stringify(detail)) };
}

function createStore({
  dbPath,
  now = () => Date.now(),
  staleSec = 900,
  tasksPerAgent = 500,
  maxTaskTitle = 4000,
  heartbeatsPerAgent = 200,
  maxDetailBytes = 8192,
  logger = null,
} = {}) {
  if (!dbPath) throw new Error('createStore 需要 dbPath');
  const db = openDatabase(dbPath);
  const log = logger && logger.child ? logger.child({ mod: 'store' }) : null;

  const stmtGetAgent = db.prepare('SELECT * FROM agents WHERE agentId = ?');
  const stmtUpsertAgent = db.prepare(`
    INSERT INTO agents (agentId, framework, model, status, tokens, costUsd, lastSeenAt, detail, registeredAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agentId) DO UPDATE SET
      framework   = excluded.framework,
      model       = COALESCE(excluded.model, agents.model),
      status      = excluded.status,
      tokens      = agents.tokens + excluded.tokens,
      costUsd     = agents.costUsd + excluded.costUsd,
      lastSeenAt  = excluded.lastSeenAt,
      detail      = excluded.detail,
      updatedAt   = excluded.updatedAt
  `);
  const stmtListAgents = db.prepare('SELECT * FROM agents ORDER BY agentId');
  const stmtInsertTask = db.prepare(`
    INSERT INTO tasks (id, agentId, title, status, createdAt, titleTruncated)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `);
  const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const stmtTasksByAgent = db.prepare('SELECT * FROM tasks WHERE agentId = ? ORDER BY createdAt DESC, id DESC LIMIT ?');
  const stmtCountTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE agentId = ?');
  const stmtPruneTasks = db.prepare(`
    DELETE FROM tasks WHERE agentId = ? AND id NOT IN (
      SELECT id FROM tasks WHERE agentId = ? ORDER BY createdAt DESC, id DESC LIMIT ?
    )
  `);
  const stmtClaimTask = db.prepare(`
    UPDATE tasks SET status = 'running', claimedAt = ?, claimedBy = ?
    WHERE id = ? AND status = 'pending'
  `);
  const stmtFinishTask = db.prepare(`
    UPDATE tasks SET status = ?, completedAt = ?, result = ?, tokens = ?, costUsd = ?
    WHERE id = ? AND status IN ('pending','running')
  `);
  const stmtInsertHeartbeat = db.prepare(`
    INSERT INTO heartbeats (agentId, status, reportedAt, detail) VALUES (?, ?, ?, ?)
  `);
  // 心跳流水按 Agent 保留上限裁剪。这张表只增不删的话，长期常驻的控制面
  // 会被自己的心跳撑爆：默认 300s 一个周期，一年就是 ~10 万行/Agent。
  const stmtPruneHeartbeats = db.prepare(`
    DELETE FROM heartbeats WHERE agentId = ? AND id NOT IN (
      SELECT id FROM heartbeats WHERE agentId = ? ORDER BY id DESC LIMIT ?
    )
  `);
  const stmtCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agents)  AS agents,
      (SELECT COUNT(*) FROM tasks)   AS tasks,
      (SELECT COUNT(*) FROM heartbeats) AS heartbeats
  `);
  const stmtTaskAgg = db.prepare(`
    SELECT agentId,
           COUNT(*) AS tasks,
           SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='running'  THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status='done'     THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(tokens)  AS tokens,
           SUM(costUsd) AS costUsd
      FROM tasks GROUP BY agentId
  `);

  function toAgent(row, at) {
    const detail = safeJson(row.detail, {});
    const lastSeenAt = row.lastSeenAt == null ? null : Number(row.lastSeenAt);
    let status = row.status;
    // 读路径纠偏：心跳断了就该显示离线，而不是最后一份心跳自称的 online
    if (staleSec > 0 && lastSeenAt != null && status !== 'offline' && at - lastSeenAt > staleSec * 1000) {
      status = 'offline';
    }
    return {
      agentId: row.agentId,
      framework: row.framework,
      model: row.model,
      status,
      reportedStatus: row.status,
      lastSeenAt,
      stale: status === 'offline' && row.status !== 'offline',
      usage: { tokens: Number(row.tokens) || 0, costUsd: Number(row.costUsd) || 0 },
      detail,
      registeredAt: Number(row.registeredAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  function toTask(row) {
    return {
      id: row.id,
      agentId: row.agentId,
      title: row.title,
      titleTruncated: row.titleTruncated === 1,
      status: row.status,
      createdAt: Number(row.createdAt),
      claimedAt: row.claimedAt == null ? null : Number(row.claimedAt),
      completedAt: row.completedAt == null ? null : Number(row.completedAt),
      claimedBy: row.claimedBy,
      result: row.result,
      usage: { tokens: Number(row.tokens) || 0, costUsd: Number(row.costUsd) || 0 },
    };
  }

  /** 心跳注册/更新。返回更新后的 agent（公开形状）。 */
  function applyHeartbeat(body) {
    const hb = normalizeHeartbeat(body, maxDetailBytes);
    if (!hb) return { ok: false, reason: 'bad_payload' };
    const at = now();
    const reportedAt = hb.reportedAt || at;
    const prev = stmtGetAgent.get(hb.agentId) || null;
    const detailJson = JSON.stringify(hb.detail || {});
    stmtUpsertAgent.run(
      hb.agentId,
      hb.framework,
      hb.model,
      hb.status,
      hb.usage ? hb.usage.tokens : 0,
      hb.usage ? hb.usage.costUsd : 0,
      reportedAt,
      detailJson,
      prev ? Number(prev.registeredAt) : at,
      at,
    );
    stmtInsertHeartbeat.run(hb.agentId, hb.status, reportedAt, detailJson);
    pruneHeartbeats(hb.agentId);
    if (log) log.info('agent heartbeat', { agentId: hb.agentId, status: hb.status });
    return { ok: true, agent: toAgent(stmtGetAgent.get(hb.agentId), at) };
  }

  /** 按 Agent 裁剪心跳流水；heartbeatsPerAgent<=0 表示不清理（显式 opt-in）。 */
  function pruneHeartbeats(agentId) {
    if (heartbeatsPerAgent <= 0) return 0;
    const r = stmtPruneHeartbeats.run(agentId, agentId, heartbeatsPerAgent);
    const removed = Number(r.changes) || 0;
    if (removed > 0 && log) {
      log.debug('heartbeats pruned', { agentId, removed, keep: heartbeatsPerAgent });
    }
    return removed;
  }

  function listAgents() {
    const at = now();
    return stmtListAgents.all().map((r) => toAgent(r, at));
  }

  function getAgent(agentId) {
    const row = stmtGetAgent.get(String(agentId || ''));
    return row ? toAgent(row, now()) : null;
  }

  function listTasks(agentId, { limit = 20 } = {}) {
    const n = Math.max(1, Math.min(500, nonNegInt(limit, 20) || 20));
    return stmtTasksByAgent.all(String(agentId || ''), n).map(toTask);
  }

  function getTask(id) {
    const row = stmtGetTask.get(String(id || ''));
    return row ? toTask(row) : null;
  }

  function createTask({ agentId, title, tokens = 0, costUsd = 0 }) {
    const id = String(agentId || '').trim();
    const t = String(title == null ? '' : title).trim();
    if (!id) return { ok: false, reason: 'agentId_required' };
    if (!t) return { ok: false, reason: 'title_required' };
    // 超长标题截断而不是整条拒绝：dispatch 的命令文本可能很长，
    // 拒绝会让用户只看到「管理面返回 413」这种无信息量文案。
    const titleTruncated = t.length > maxTaskTitle;
    const finalTitle = titleTruncated ? t.slice(0, maxTaskTitle) : t;
    const at = now();
    const taskId = newTaskId(at);
    stmtInsertTask.run(taskId, id, finalTitle, at, titleTruncated ? 1 : 0);
    pruneTasks(id);
    if (log) log.info('task created', { taskId, agentId: id, titleTruncated });
    return { ok: true, task: toTask(stmtGetTask.get(taskId)), titleTruncated };
  }

  function pruneTasks(agentId) {
    if (tasksPerAgent <= 0) return 0;
    const total = Number(stmtCountTasks.get(agentId).n) || 0;
    if (total <= tasksPerAgent) return 0;
    const r = stmtPruneTasks.run(agentId, agentId, tasksPerAgent);
    if (log) log.info('tasks pruned', { agentId, removed: Number(r.changes) || 0, keep: tasksPerAgent });
    return Number(r.changes) || 0;
  }

  function claimTask(id, claimedBy) {
    const at = now();
    const r = stmtClaimTask.run(at, String(claimedBy || '').slice(0, 200) || null, String(id || ''));
    if (!(Number(r.changes) > 0)) {
      const cur = getTask(id);
      if (!cur) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'not_pending', status: cur.status, task: cur };
    }
    if (log) log.info('task claimed', { taskId: id, claimedBy });
    return { ok: true, task: getTask(id) };
  }

  function completeTask(id, { status = 'done', result = null, tokens = 0, costUsd = 0 } = {}) {
    const finalStatus = TASK_STATUS.has(status) ? status : 'done';
    if (!['done', 'failed', 'cancelled'].includes(finalStatus)) {
      return { ok: false, reason: 'bad_status', allowed: ['done', 'failed', 'cancelled'] };
    }
    const at = now();
    const r = stmtFinishTask.run(
      finalStatus, at,
      result == null ? null : String(result).slice(0, 20000),
      nonNegInt(tokens, 0), nonNegFloat(costUsd, 0),
      String(id || ''),
    );
    if (!(Number(r.changes) > 0)) {
      const cur = getTask(id);
      if (!cur) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'not_open', status: cur.status, task: cur };
    }
    if (log) log.info('task completed', { taskId: id, status: finalStatus });
    return { ok: true, task: getTask(id) };
  }

  function costSummary() {
    const at = now();
    const agents = listAgents();
    const rows = stmtTaskAgg.all();
    const byAgent = {};
    let totalTokens = 0;
    let totalCostUsd = 0;
    let taskCount = 0;
    const tasksByStatus = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const a of agents) {
      byAgent[a.agentId] = {
        status: a.status,
        heartbeatTokens: a.usage.tokens,
        heartbeatCostUsd: a.usage.costUsd,
        taskTokens: 0,
        taskCostUsd: 0,
        tokens: a.usage.tokens,
        costUsd: a.usage.costUsd,
        tasks: 0, done: 0, pending: 0, running: 0, failed: 0, cancelled: 0,
      };
    }
    for (const r of rows) {
      const id = String(r.agentId);
      const entry = byAgent[id] || (byAgent[id] = {
        status: 'unknown', heartbeatTokens: 0, heartbeatCostUsd: 0,
        taskTokens: 0, taskCostUsd: 0, tokens: 0, costUsd: 0,
        tasks: 0, done: 0, pending: 0, running: 0, failed: 0, cancelled: 0,
      });
      const tokens = Number(r.tokens) || 0;
      const cost = Number(r.costUsd) || 0;
      entry.taskTokens = tokens;
      entry.taskCostUsd = cost;
      entry.tokens = entry.heartbeatTokens + tokens;
      entry.costUsd = entry.heartbeatCostUsd + cost;
      entry.tasks = Number(r.tasks) || 0;
      entry.done = Number(r.done) || 0;
      entry.pending = Number(r.pending) || 0;
      entry.running = Number(r.running) || 0;
      entry.failed = Number(r.failed) || 0;
      entry.cancelled = Number(r.cancelled) || 0;
      taskCount += entry.tasks;
      tasksByStatus.pending += entry.pending;
      tasksByStatus.running += entry.running;
      tasksByStatus.done += entry.done;
      tasksByStatus.failed += entry.failed;
      tasksByStatus.cancelled += entry.cancelled;
    }
    for (const k of Object.keys(byAgent)) {
      totalTokens += byAgent[k].tokens;
      totalCostUsd += byAgent[k].costUsd;
    }
    return {
      totalTokens,
      totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
      taskCount,
      tasksByStatus,
      agentCount: Object.keys(byAgent).length,
      byAgent,
      generatedAt: at,
    };
  }

  function counts() {
    const c = stmtCounts.get();
    return { agents: Number(c.agents) || 0, tasks: Number(c.tasks) || 0, heartbeats: Number(c.heartbeats) || 0 };
  }

  function close() {
    try { db.close(); } catch { /* 已关闭 */ }
  }

  return {
    applyHeartbeat, listAgents, getAgent, listTasks, getTask,
    createTask, claimTask, completeTask, costSummary, counts, pruneTasks, close,
    pruneHeartbeats,
    isOpenStatus: (s) => OPEN_STATUS.has(s),
  };
}

module.exports = {
  createStore, openDatabase, normalizeHeartbeat, capDetail, newTaskId,
  sqliteAvailable, TASK_STATUS, OPEN_STATUS, SCHEMA, HEARTBEAT_FIELD_LIMITS,
};
