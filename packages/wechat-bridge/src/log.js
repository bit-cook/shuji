'use strict';
/**
 * 极简 JSON 结构化日志（journald 友好，风格与 hermes-sidecar 一致）。
 * 默认写 stderr：stdout 只留给启动横幅等协议无关输出，日志永远不污染协议通道。
 * 日志写失败（EPIPE 等）不影响主流程。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger({
  level = process.env.LOG_LEVEL || 'info',
  stream = process.stderr,
  now = () => new Date().toISOString(),
  base = {},
} = {}) {
  const min = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  function write(lv, msg, fields) {
    if ((LEVELS[lv] || 0) < min) return;
    let line;
    try {
      line = JSON.stringify({ ts: now(), level: lv, msg, ...base, ...(fields || {}) });
    } catch { return; }
    try { stream.write(line + '\n'); } catch { /* 日志失败不影响主流程 */ }
  }

  const logger = {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    level: min,
    /** 派生一个带固定上下文字段的 logger（如 adapter 名） */
    child(extra = {}) {
      return createLogger({ level, stream, now, base: { ...base, ...extra } });
    },
  };
  return logger;
}

/** 静默 logger：测试用，零输出。 */
function createNoopLogger() {
  const f = () => {};
  return { debug: f, info: f, warn: f, error: f, level: 99, child: () => createNoopLogger() };
}

module.exports = { createLogger, createNoopLogger, LEVELS };
