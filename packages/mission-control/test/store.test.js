'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStore, normalizeHeartbeat, newTaskId, sqliteAvailable, TASK_STATUS,
} = require('../src/store');

let tmpDir;
let dbPath;
let counter = 0;

function freshStore(opts = {}) {
  counter += 1;
  return createStore({
    dbPath: path.join(tmpDir, `db-${counter}.db`),
    ...opts,
  });
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-mc-'));
});
after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('node:sqlite 可用性', () => {
  test('当前 Node 提供 node:sqlite', () => {
    assert.equal(sqliteAvailable(), true, `Node ${process.version} 应有 node:sqlite`);
  });
});

describe('心跳注册', () => {
  test('generic 协议报文注册 Agent 并保留 detail', () => {
    const s = freshStore({ now: () => 1700000000000 });
    const r = s.applyHeartbeat({
      framework: 'generic',
      action: 'heartbeat',
      payload: {
        agentId: 'hermes-node-b', status: 'online', reportedAt: 1700000000000,
        detail: { sessions: 3, reportedBy: 'hermes-sidecar/0.3.0' },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.agent.agentId, 'hermes-node-b');
    assert.equal(r.agent.status, 'online');
    assert.equal(r.agent.lastSeenAt, 1700000000000);
    assert.equal(r.agent.detail.sessions, 3);
    assert.deepEqual(s.listAgents().map((a) => a.agentId), ['hermes-node-b']);
    s.close();
  });

  test('裸字段报文（无 payload 包装）同样接受', () => {
    const s = freshStore();
    const r = s.applyHeartbeat({ agentId: 'node-openclaw', status: 'online' });
    assert.equal(r.ok, true);
    assert.equal(r.agent.framework, 'generic');
    s.close();
  });

  test('重复心跳更新 lastSeenAt，不产生第二个 Agent', () => {
    let t = 1000;
    const s = freshStore({ now: () => t });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    t = 5000;
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    const list = s.listAgents();
    assert.equal(list.length, 1);
    assert.equal(list[0].lastSeenAt, 5000);
    s.close();
  });

  test('heartbeat 里的 usage 累计进 Agent 成本', () => {
    let t = 1000;
    const s = freshStore({ now: () => t });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', detail: { usage: { tokens: 100, costUsd: 0.25 } } } });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', detail: { usage: { tokens: 50, costUsd: 0.1 } } } });
    const a = s.getAgent('a');
    assert.equal(a.usage.tokens, 150);
    assert.equal(a.usage.costUsd, 0.35);
    s.close();
  });

  test('坏报文返回可读原因而不是抛异常', () => {
    const s = freshStore();
    assert.equal(s.applyHeartbeat(null).ok, false);
    assert.equal(s.applyHeartbeat({}).ok, false);
    assert.equal(s.applyHeartbeat({ payload: { agentId: '  ' } }).ok, false);
    s.close();
  });

  test('detail 非对象时按空对象处理', () => {
    const s = freshStore();
    const r = s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', detail: 'oops' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.agent.detail, {});
    s.close();
  });

  test('秒级 reportedAt 被换算成毫秒（否则刚上报就被判离线）', () => {
    // generic 协议发的是 int(time.time())（秒）；与 Date.now()（毫秒）混用会让
    // 「心跳超时纠偏」把刚上报的 Agent 立刻判成 offline。
    const nowMs = 1793876108000;
    const s = freshStore({ now: () => nowMs, staleSec: 900 });
    const r = s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: 1793876108 } });
    assert.equal(r.agent.lastSeenAt, nowMs);
    assert.equal(r.agent.status, 'online');
    assert.equal(r.agent.stale, false);
    s.close();
  });

  test('毫秒级 reportedAt 原样保留（不重复乘 1000）', () => {
    const nowMs = 1793876108000;
    const s = freshStore({ now: () => nowMs, staleSec: 900 });
    const r = s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: nowMs } });
    assert.equal(r.agent.lastSeenAt, nowMs);
    s.close();
  });

  test('缺 reportedAt 时用本机当前时间', () => {
    const nowMs = 1793876108000;
    const s = freshStore({ now: () => nowMs });
    const r = s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    assert.equal(r.agent.lastSeenAt, nowMs);
    s.close();
  });
});

describe('心跳超时纠偏（读路径）', () => {
  test('超过 staleSec 未心跳 → /list 报 offline 且标记 stale', () => {
    let t = 1793876108000;
    const s = freshStore({ now: () => t, staleSec: 900 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    t += 900 * 1000 + 1;
    const a = s.getAgent('a');
    assert.equal(a.status, 'offline');
    assert.equal(a.reportedStatus, 'online');
    assert.equal(a.stale, true);
    s.close();
  });

  test('staleSec=0 关闭纠偏，保留上报状态', () => {
    let t = 1793876108000;
    const s = freshStore({ now: () => t, staleSec: 0 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    t += 10 * 365 * 24 * 3600 * 1000;
    assert.equal(s.getAgent('a').status, 'online');
    s.close();
  });

  test('Agent 自报 offline 时不叠加 stale 标记', () => {
    let t = 1793876108000;
    const s = freshStore({ now: () => t, staleSec: 60 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'offline', reportedAt: t } });
    t += 10 * 60 * 1000;
    const a = s.getAgent('a');
    assert.equal(a.status, 'offline');
    assert.equal(a.stale, false);
    s.close();
  });
});

describe('任务生命周期', () => {
  test('下发 → 领取 → 完成的完整链路', () => {
    let t = 1000;
    const s = freshStore({ now: () => t });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    const created = s.createTask({ agentId: 'a', title: '夜间巡检一次' });
    assert.equal(created.ok, true);
    assert.equal(created.task.status, 'pending');
    assert.ok(created.task.id.startsWith('task-'));

    const claimed = s.claimTask(created.task.id, 'worker-1');
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.status, 'running');
    assert.equal(claimed.task.claimedBy, 'worker-1');
    assert.equal(claimed.task.claimedAt, t);

    t = 2000;
    const done = s.completeTask(created.task.id, { status: 'done', tokens: 1000, costUsd: 0.02, result: 'ok' });
    assert.equal(done.ok, true);
    assert.equal(done.task.status, 'done');
    assert.equal(done.task.completedAt, 2000);
    assert.equal(done.task.usage.tokens, 1000);
    assert.equal(done.task.result, 'ok');
    s.close();
  });

  test('重复领取返回 not_pending 且不破坏原任务', () => {
    let t = 1000;
    const s = freshStore({ now: () => t });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    const { task } = s.createTask({ agentId: 'a', title: 'x' });
    assert.equal(s.claimTask(task.id, 'w1').ok, true);
    const again = s.claimTask(task.id, 'w2');
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'not_pending');
    assert.equal(again.status, 'running');
    assert.equal(s.getTask(task.id).claimedBy, 'w1');
    s.close();
  });

  test('领取不存在的任务 → not_found', () => {
    const s = freshStore();
    const r = s.claimTask('task-nope', 'w');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_found');
    s.close();
  });

  test('完成后不能再完成 → not_open', () => {
    const s = freshStore();
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    const { task } = s.createTask({ agentId: 'a', title: 'x' });
    s.completeTask(task.id, { status: 'done' });
    const again = s.completeTask(task.id, { status: 'failed' });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'not_open');
    assert.equal(again.status, 'done');
    s.close();
  });

  test('complete 拒绝把任务设成 pending/running', () => {
    const s = freshStore();
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    const { task } = s.createTask({ agentId: 'a', title: 'x' });
    const r = s.completeTask(task.id, { status: 'running' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_status');
    assert.deepEqual(r.allowed, ['done', 'failed', 'cancelled']);
    assert.equal(s.getTask(task.id).status, 'pending');
    s.close();
  });

  test('未知 status 归一到 done（不静默失败）', () => {
    const s = freshStore();
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    const { task } = s.createTask({ agentId: 'a', title: 'x' });
    const r = s.completeTask(task.id, { status: 'weird' });
    assert.equal(r.ok, true);
    assert.equal(r.task.status, 'done');
    s.close();
  });

  test('标题为空 / agentId 缺失被拒', () => {
    const s = freshStore({ maxTaskTitle: 20 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    assert.equal(s.createTask({ agentId: 'a', title: '   ' }).reason, 'title_required');
    assert.equal(s.createTask({ agentId: '', title: 'x' }).reason, 'agentId_required');
    s.close();
  });

  test('超长标题截断并标记 titleTruncated（不整条拒绝）', () => {
    const s = freshStore({ maxTaskTitle: 10 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    const r = s.createTask({ agentId: 'a', title: '这是一段很长的任务说明'.repeat(3) });
    assert.equal(r.ok, true);
    assert.equal(r.titleTruncated, true);
    assert.equal(r.task.title.length, 10);
    assert.equal(r.task.titleTruncated, true);
    const short = s.createTask({ agentId: 'a', title: '短任务' });
    assert.equal(short.titleTruncated, false);
    assert.equal(short.task.titleTruncated, false);
    s.close();
  });

  test('tasks 按 createdAt 倒序返回', () => {
    let t = 1000;
    const s = freshStore({ now: () => t });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    s.createTask({ agentId: 'a', title: 'first' }); t += 10;
    s.createTask({ agentId: 'a', title: 'second' }); t += 10;
    s.createTask({ agentId: 'a', title: 'third' });
    assert.deepEqual(s.listTasks('a').map((x) => x.title), ['third', 'second', 'first']);
    s.close();
  });

  test('任务按 Agent 隔离', () => {
    const s = freshStore();
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    s.applyHeartbeat({ payload: { agentId: 'b', status: 'online' } });
    s.createTask({ agentId: 'a', title: 'x' });
    s.createTask({ agentId: 'b', title: 'y' });
    assert.equal(s.listTasks('a').length, 1);
    assert.equal(s.listTasks('b').length, 1);
    assert.equal(s.listTasks('c').length, 0);
    s.close();
  });

  test('每 Agent 任务数上限裁剪最旧的', () => {
    let t = 1000;
    const s = freshStore({ now: () => t, tasksPerAgent: 3 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    for (let i = 0; i < 6; i++) { s.createTask({ agentId: 'a', title: 't' + i }); t += 1; }
    const titles = s.listTasks('a', { limit: 50 }).map((x) => x.title);
    assert.equal(titles.length, 3);
    assert.deepEqual(titles, ['t5', 't4', 't3']);
    assert.equal(s.counts().tasks, 3);
    s.close();
  });

  test('tasksPerAgent=0 不裁剪', () => {
    let t = 1000;
    const s = freshStore({ now: () => t, tasksPerAgent: 0 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    for (let i = 0; i < 10; i++) { s.createTask({ agentId: 'a', title: 't' + i }); t += 1; }
    assert.equal(s.counts().tasks, 10);
    s.close();
  });
});

describe('成本汇总', () => {
  test('心跳 usage 与任务 usage 合并，按 Agent 分组', () => {
    let t = 1000;
    const s = freshStore({ now: () => t });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t, detail: { usage: { tokens: 100, costUsd: 0.5 } } } });
    s.applyHeartbeat({ payload: { agentId: 'b', status: 'online', reportedAt: t } });
    const ta = s.createTask({ agentId: 'a', title: 'x' }).task;
    const tb = s.createTask({ agentId: 'b', title: 'y' }).task;
    s.completeTask(ta.id, { status: 'done', tokens: 900, costUsd: 1.5 });
    s.completeTask(tb.id, { status: 'failed', tokens: 10, costUsd: 0 });

    const c = s.costSummary();
    assert.equal(c.totalTokens, 1010);
    assert.equal(c.totalCostUsd, 2);
    assert.equal(c.taskCount, 2);
    assert.equal(c.agentCount, 2);
    assert.equal(c.tasksByStatus.done, 1);
    assert.equal(c.tasksByStatus.failed, 1);
    assert.equal(c.byAgent.a.tokens, 1000);
    assert.equal(c.byAgent.a.heartbeatTokens, 100);
    assert.equal(c.byAgent.a.taskTokens, 900);
    assert.equal(c.byAgent.b.tokens, 10);
    s.close();
  });

  test('空库返回零值而不是报错', () => {
    const s = freshStore();
    const c = s.costSummary();
    assert.equal(c.totalTokens, 0);
    assert.equal(c.totalCostUsd, 0);
    assert.equal(c.taskCount, 0);
    assert.deepEqual(c.byAgent, {});
    s.close();
  });

  test('costUsd 累计浮点误差被收敛', () => {
    const s = freshStore();
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    for (let i = 0; i < 3; i++) {
      const { task } = s.createTask({ agentId: 'a', title: 'x' });
      s.completeTask(task.id, { status: 'done', costUsd: 0.1 });
    }
    assert.equal(s.costSummary().totalCostUsd, 0.3);
    s.close();
  });
});

describe('持久化', () => {
  test('重开数据库后 Agent 与任务仍在（bridge 重启不丢数据）', () => {
    const file = path.join(tmpDir, 'persist.db');
    let t = 1000;
    const s1 = createStore({ dbPath: file, now: () => t });
    s1.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: t } });
    const { task } = s1.createTask({ agentId: 'a', title: '夜间巡检' });
    s1.close();

    t = 2000;
    const s2 = createStore({ dbPath: file, now: () => t, staleSec: 900 });
    assert.equal(s2.getAgent('a').agentId, 'a');
    assert.equal(s2.getTask(task.id).title, '夜间巡检');
    assert.equal(s2.counts().tasks, 1);
    s2.close();
  });
});

describe('报文归一化', () => {
  test('normalizeHeartbeat 兼容多种字段名', () => {
    const h = normalizeHeartbeat({ agent_id: 'a', reported_at: 1700000000 });
    assert.equal(h.agentId, 'a');
    assert.equal(h.reportedAt, 1700000000000);
    const h2 = normalizeHeartbeat({ payload: { agentId: 'a', lastSeenAt: 1700000000000 } });
    assert.equal(h2.reportedAt, 1700000000000);
    const h3 = normalizeHeartbeat({ payload: { agentId: 'a' } });
    assert.equal(h3.reportedAt, null);
  });

  test('usage 可放在 payload 顶层或 detail 里', () => {
    assert.equal(normalizeHeartbeat({ payload: { agentId: 'a', usage: { tokens: 1 } } }).usage.tokens, 1);
    assert.equal(normalizeHeartbeat({ payload: { agentId: 'a', detail: { usage: { tokens: 2 } } } }).usage.tokens, 2);
    assert.equal(normalizeHeartbeat({ payload: { agentId: 'a' } }).usage, null);
  });

  test('usage 里的负数被归零', () => {
    const h = normalizeHeartbeat({ payload: { agentId: 'a', usage: { tokens: -5, costUsd: -1 } } });
    assert.equal(h.usage.tokens, 0);
    assert.equal(h.usage.costUsd, 0);
  });

  test('newTaskId 唯一且带前缀', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(newTaskId(1700000000000));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^task-[a-z0-9]+-[a-z0-9]+$/);
  });

  test('TASK_STATUS 含全部合法终态', () => {
    for (const s of ['pending', 'running', 'done', 'failed', 'cancelled']) {
      assert.ok(TASK_STATUS.has(s));
    }
  });
});

// ---- 心跳流水与 detail 的体积上限：控制面要长期常驻，不能被自己的心跳撑爆 ----
describe('心跳流水保留上限', () => {
  test('超过 heartbeatsPerAgent 的行被裁掉，只留最近 N 条', () => {
    const s = freshStore({ now: () => 1700000000000, heartbeatsPerAgent: 5 });
    for (let i = 0; i < 12; i++) {
      s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', reportedAt: 1700000000 + i } });
    }
    const c = s.counts();
    assert.equal(c.heartbeats, 5, `应只保留 5 条，实际 ${c.heartbeats}`);
  });

  test('保留的是最近的那些，不是最旧的', () => {
    const s = freshStore({ now: () => 1700000000000, heartbeatsPerAgent: 3 });
    for (let i = 1; i <= 6; i++) {
      s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', detail: { seq: i } } });
    }
    // Agent 行始终是最新一份心跳的 detail
    assert.equal(s.getAgent('a').detail.seq, 6);
    const c = s.counts();
    assert.equal(c.heartbeats, 3);
  });

  test('按 Agent 分别计数：一个话痨 Agent 不会冲掉别人的历史', () => {
    const s = freshStore({ now: () => 1700000000000, heartbeatsPerAgent: 4 });
    for (let i = 0; i < 20; i++) {
      s.applyHeartbeat({ payload: { agentId: 'chatty', status: 'online' } });
      if (i % 5 === 0) s.applyHeartbeat({ payload: { agentId: 'quiet', status: 'online' } });
    }
    const c = s.counts();
    assert.equal(c.heartbeats, 4 + 4, `chatty 4 + quiet 4，实际 ${c.heartbeats}`);
  });

  test('heartbeatsPerAgent=0 显式关闭清理（默认不是这个）', () => {
    const s = freshStore({ now: () => 1700000000000, heartbeatsPerAgent: 0 });
    for (let i = 0; i < 10; i++) {
      s.applyHeartbeat({ payload: { agentId: 'a', status: 'online' } });
    }
    assert.equal(s.counts().heartbeats, 10);
  });
});

describe('心跳 detail 大小上限', () => {
  test('超大 detail 被裁到上限以内，且带截断标记', () => {
    const big = { blob: 'x'.repeat(50000), keep: 'small' };
    const h = normalizeHeartbeat({ payload: { agentId: 'a', detail: big } }, 2048);
    const size = Buffer.byteLength(JSON.stringify(h.detail));
    assert.ok(size <= 2048, `detail 应 <= 2048 字节，实际 ${size}`);
    assert.equal(h.detail._detailTruncated, true);
  });

  test('上限内的 detail 原样保留，不加标记', () => {
    const h = normalizeHeartbeat({ payload: { agentId: 'a', detail: { a: 1, b: 'x' } } }, 2048);
    assert.deepEqual(h.detail, { a: 1, b: 'x' });
  });

  test('裁到库里的 detail 也受上限约束（agents 行不会变成大字段）', () => {
    const s = freshStore({ now: () => 1700000000000, maxDetailBytes: 1024 });
    s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', detail: { blob: 'y'.repeat(40000) } } });
    const a = s.getAgent('a');
    assert.ok(Buffer.byteLength(JSON.stringify(a.detail)) <= 1024, 'agent.detail 超限');
    assert.equal(a.detail._detailTruncated, true);
  });

  test('Agent 本身照常注册：detail 超限不该让 Agent 掉线', () => {
    const s = freshStore({ now: () => 1700000000000, maxDetailBytes: 512 });
    const r = s.applyHeartbeat({ payload: { agentId: 'a', status: 'online', detail: { blob: 'z'.repeat(9000) } } });
    assert.equal(r.ok, true);
    assert.equal(r.agent.agentId, 'a');
    assert.equal(r.agent.status, 'online');
  });

  test('capDetail：maxBytes<=0 表示不限制', () => {
    const { capDetail } = require('../src/store');
    const d = { a: 'x'.repeat(1000) };
    assert.equal(capDetail(d, 0), d);
  });
});
