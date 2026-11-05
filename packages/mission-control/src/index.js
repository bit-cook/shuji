'use strict';
/**
 * 枢机 · Mission-Control —— 控制面。
 * 一行装配：createMissionControl({ env }) → { config, store, http, listen, close }
 */
const fs = require('node:fs');
const path = require('node:path');

const { parseConfig, ConfigError, DEFAULTS, guardPublicBind } = require('./config');
const { createStore, sqliteAvailable } = require('./store');
const { createControlServer } = require('./server');
const { createLogger, createNoopLogger } = require('./log');
const { createAudit } = require('./audit');
const { createStats } = require('./stats');
const { createRateLimiter } = require('./ratelimit');

function createMissionControl({
  env = process.env,
  cwd = process.cwd,
  logger,
  now = () => Date.now(),
} = {}) {
  const cwdFn = typeof cwd === 'function' ? cwd : () => cwd;
  const { config, errors, warnings } = parseConfig(env, { cwd: cwdFn() });
  const log = logger || createLogger({ level: config.logLevel });
  for (const w of warnings) log.warn(w);

  if (errors.length) {
    const err = new ConfigError(errors);
    err.warnings = warnings;
    throw err;
  }

  // 数据库与审计目录：缺失就建（部署时只需给父目录权限）
  for (const f of [config.dbPath, config.auditFile]) {
    if (!f || f === 'none') continue;
    const dir = path.dirname(f);
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }

  const store = createStore({
    dbPath: config.dbPath,
    now,
    staleSec: config.staleSec,
    tasksPerAgent: config.tasksPerAgent,
    heartbeatsPerAgent: config.heartbeatsPerAgent,
    maxDetailBytes: config.maxDetailBytes,
    maxTaskTitle: config.maxTaskTitle,
    logger: log,
  });

  const http = createControlServer({
    config,
    store,
    logger: log,
    now,
    audit: createAudit({
      file: config.auditFile,
      maxBytes: config.auditMaxBytes,
      keep: config.auditKeep,
    }),
    stats: createStats({ now }),
    rateLimiter: createRateLimiter({
      perMinute: config.rateLimitPerMin,
      burst: config.rateLimitBurst,
      now,
    }),
  });

  return {
    config,
    store,
    http,
    warnings,
    listen: (port = config.port, host = config.host) => http.listen(port, host),
    close: async () => {
      await http.close();
      store.close();
    },
  };
}

module.exports = {
  createMissionControl,
  parseConfig,
  ConfigError,
  DEFAULTS,
  guardPublicBind,
  createStore,
  createControlServer,
  sqliteAvailable,
};
