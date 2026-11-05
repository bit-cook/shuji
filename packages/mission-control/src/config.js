'use strict';
/**
 * 控制面配置解析与校验（纯函数，供 CLI --check 与测试复用）。
 * 红线：
 *   - MC_API_KEY 必填（控制面是全局下令入口，无鉴权等于把全部 Agent 交给同主机任何账号）
 *   - 默认只绑 127.0.0.1；绑 0.0.0.0 / :: 需显式 ALLOW_PUBLIC_BIND=1
 *   - 审计默认开启（显式 none 才关闭）
 */
const path = require('node:path');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  dbPath: 'mission-control.db',
  auditFile: 'audit.jsonl',
  auditMaxBytes: 10 * 1024 * 1024,
  auditKeep: 3,
  rateLimitPerMin: 600,
  rateLimitBurst: 200,
  maxBodyBytes: 1024 * 1024,
  staleSec: 900,        // 超过此时长未心跳 → /list 报 offline；0 = 关闭
  tasksPerAgent: 500,   // 每 Agent 保留的任务条数上限；0 = 不清理
  heartbeatsPerAgent: 200, // 每 Agent 保留的心跳流水条数；0 = 不清理（不推荐）
  maxDetailBytes: 8192, // 心跳 detail 的大小上限，防失灵的 Agent 把库撑爆
  maxTaskTitle: 4000,
  requestTimeoutMs: 10000,
  panel: true,                 // 网页可视化面板（只读），MC_PANEL=0 关闭
  panelSessionTtlMs: 12 * 60 * 60 * 1000, // 面板会话有效期
  panelLoginPerMin: 5,         // 面板登录尝试限流（每 IP 每分钟）
};

class ConfigError extends Error {
  constructor(errors) {
    super(Array.isArray(errors) ? errors.join('；') : String(errors));
    this.name = 'ConfigError';
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
  }
}

function num(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 环境变量「显式写了但不是数字」时返回 false——静默回落默认值会让运维
 * 以为端口/周期已生效（实际跑在 3000 上），这类拼错必须报错。
 */
function isNumericLiteral(value) {
  if (value === undefined || value === null) return true;
  const s = String(value).trim();
  if (s === '') return true;
  return Number.isFinite(Number(s));
}

function bool(value) {
  return String(value || '').trim() === '1' || String(value || '').trim().toLowerCase() === 'true';
}

/** 通配地址 = 全部网卡。生产里这通常意味着暴露公网。 */
function isPublicHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === '0.0.0.0' || h === '::' || h === '::0' || h === '*';
}

function guardPublicBind(host, env = process.env) {
  if (!isPublicHost(host)) return;
  if (String(env.ALLOW_PUBLIC_BIND || '') === '1') {
    process.stderr.write('[warn] 已按 ALLOW_PUBLIC_BIND=1 绑定通配地址——确认该网卡不是公网\n');
    return;
  }
  throw new ConfigError([
    `拒绝绑定 ${host}：控制面端口不得暴露公网（红线）。`,
    '  跨主机请绑 Tailscale 网卡地址（hostname -I 查 100.x.x.x），或保持 MC_HOST=127.0.0.1；',
    '  确需通配绑定时显式设置 ALLOW_PUBLIC_BIND=1。',
  ]);
}

/**
 * 解析环境变量。返回 { config, errors, warnings }——
 * errors 非空时配置不可用；warnings 是可运行但不推荐的组合。
 */
function parseConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const errors = [];
  const warnings = [];

  const host = String(env.MC_HOST ?? DEFAULTS.host).trim() || DEFAULTS.host;
  if (env.MC_HOST !== undefined && String(env.MC_HOST).trim() === '') {
    warnings.push('MC_HOST 为空，按 127.0.0.1 处理（不会绑通配地址）');
  }
  if (!isNumericLiteral(env.MC_PORT)) errors.push(`MC_PORT 不是数字：${env.MC_PORT}`);
  const port = Math.floor(num(env.MC_PORT, DEFAULTS.port));
  if (!(port > 0 && port < 65536)) errors.push(`MC_PORT 非法：${env.MC_PORT}`);

  const apiKey = String(env.MC_API_KEY ?? '').trim();
  if (!apiKey) errors.push('MC_API_KEY 未配置（控制面 API Key，红线：无鉴权即全局可下令）');
  else if (apiKey.length < 16) warnings.push('MC_API_KEY 短于 16 字符，建议用随机长字符串');

  const dbRaw = String(env.MC_DB ?? DEFAULTS.dbPath).trim() || DEFAULTS.dbPath;
  const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.resolve(cwd, dbRaw);

  const auditFile = String(env.MC_AUDIT_LOG ?? DEFAULTS.auditFile).trim();
  const auditMaxBytes = Math.floor(num(env.MC_AUDIT_MAX_BYTES, DEFAULTS.auditMaxBytes));
  const auditKeep = Math.floor(num(env.MC_AUDIT_KEEP, DEFAULTS.auditKeep));
  if (auditMaxBytes < 0) errors.push('MC_AUDIT_MAX_BYTES 不能为负');
  if (auditKeep < 1) errors.push('MC_AUDIT_KEEP 至少为 1');

  const rateLimitPerMin = Math.floor(num(env.MC_RATE_LIMIT_PER_MIN, DEFAULTS.rateLimitPerMin));
  const rateLimitBurst = Math.floor(num(env.MC_RATE_LIMIT_BURST, DEFAULTS.rateLimitBurst));
  if (rateLimitPerMin < 0) errors.push('MC_RATE_LIMIT_PER_MIN 不能为负');
  if (rateLimitBurst < 1) errors.push('MC_RATE_LIMIT_BURST 至少为 1');

  const maxBodyBytes = Math.floor(num(env.MC_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes));
  if (maxBodyBytes < 1024) errors.push('MC_MAX_BODY_BYTES 至少 1024 字节');

  const staleSec = Math.floor(num(env.MC_STALE_SEC, DEFAULTS.staleSec));
  if (staleSec < 0) errors.push('MC_STALE_SEC 不能为负');

  const tasksPerAgent = Math.floor(num(env.MC_TASKS_PER_AGENT, DEFAULTS.tasksPerAgent));
  if (tasksPerAgent < 0) errors.push('MC_TASKS_PER_AGENT 不能为负');

  const heartbeatsPerAgent = Math.floor(num(env.MC_HEARTBEATS_PER_AGENT, DEFAULTS.heartbeatsPerAgent));
  if (heartbeatsPerAgent < 0) errors.push('MC_HEARTBEATS_PER_AGENT 不能为负');
  if (heartbeatsPerAgent === 0) {
    warnings.push('MC_HEARTBEATS_PER_AGENT=0：心跳流水不清理。控制面长期常驻，按默认周期一年就是 ~10 万行/Agent，确认这是有意的');
  }

  const maxDetailBytes = Math.floor(num(env.MC_MAX_DETAIL_BYTES, DEFAULTS.maxDetailBytes));
  if (maxDetailBytes < 256) errors.push('MC_MAX_DETAIL_BYTES 至少 256 字节');

  const maxTaskTitle = Math.floor(num(env.MC_MAX_TASK_TITLE, DEFAULTS.maxTaskTitle));
  if (maxTaskTitle < 16) errors.push('MC_MAX_TASK_TITLE 至少 16 字符');

  const logLevel = String(env.LOG_LEVEL || env.MC_LOG_LEVEL || 'info').toLowerCase();

  // 面板开关只认精确值，拼成 yes/on 会静默按默认值走（该开的没开）
  const panelRaw = String(env.MC_PANEL ?? '').trim();
  if (panelRaw && !['0', '1'].includes(panelRaw)) {
    errors.push(`MC_PANEL 只能是 0 或 1，当前为 ${env.MC_PANEL}`);
  }
  const panel = panelRaw !== '0';

  const panelSessionTtlMs = Math.floor(num(env.MC_PANEL_SESSION_TTL_MS, DEFAULTS.panelSessionTtlMs));
  if (panelSessionTtlMs < 60000) errors.push('MC_PANEL_SESSION_TTL_MS 至少 60000（1 分钟）');

  const panelLoginPerMin = Math.floor(num(env.MC_PANEL_LOGIN_PER_MIN, DEFAULTS.panelLoginPerMin));
  if (panelLoginPerMin < 1) errors.push('MC_PANEL_LOGIN_PER_MIN 至少为 1');

  // 拼错的数字一律报错，不静默回落默认值
  for (const key of [
    'MC_AUDIT_MAX_BYTES', 'MC_AUDIT_KEEP', 'MC_RATE_LIMIT_PER_MIN', 'MC_RATE_LIMIT_BURST',
    'MC_MAX_BODY_BYTES', 'MC_STALE_SEC', 'MC_TASKS_PER_AGENT', 'MC_MAX_TASK_TITLE',
    'MC_REQUEST_TIMEOUT_MS', 'MC_HEARTBEATS_PER_AGENT', 'MC_MAX_DETAIL_BYTES',
    'MC_PANEL_SESSION_TTL_MS', 'MC_PANEL_LOGIN_PER_MIN',
  ]) {
    if (!isNumericLiteral(env[key])) errors.push(`${key} 不是数字：${env[key]}`);
  }

  if (!apiKey && !errors.some((e) => e.includes('MC_API_KEY'))) {
    errors.push('MC_API_KEY 未配置（控制面 API Key，红线：无鉴权即全局可下令）');
  }
  if (!auditFile || auditFile === 'none') {
    warnings.push('审计已关闭（MC_AUDIT_LOG=none）：控制面操作将无留痕，仅建议调试时使用');
  }
  if (isPublicHost(host) && String(env.ALLOW_PUBLIC_BIND || '') !== '1') {
    errors.push(`拒绝绑定 ${host}：控制面端口不得暴露公网（红线），需显式 ALLOW_PUBLIC_BIND=1`);
  }

  return {
    config: {
      host,
      port,
      apiKey,
      dbPath,
      auditFile,
      auditMaxBytes,
      auditKeep,
      rateLimitPerMin,
      rateLimitBurst,
      maxBodyBytes,
      staleSec,
      tasksPerAgent,
      heartbeatsPerAgent,
      maxDetailBytes,
      maxTaskTitle,
      requestTimeoutMs: Math.floor(num(env.MC_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs)),
      logLevel,
      panel,
      panelSessionTtlMs,
      panelLoginPerMin,
    },
    errors,
    warnings,
  };
}

module.exports = {
  DEFAULTS, ConfigError, parseConfig, guardPublicBind, isPublicHost, num, bool, isNumericLiteral,
};
