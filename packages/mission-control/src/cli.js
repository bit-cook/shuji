#!/usr/bin/env node
'use strict';
/**
 * 控制面 CLI。
 *   node src/cli.js            启动（读环境变量）
 *   node src/cli.js --check    只校验配置与数据库可写，不监听
 *   node src/cli.js --version
 *   node src/cli.js --help
 * SIGTERM/SIGINT 优雅停机：先关 HTTP，再关 SQLite（WAL  checkpoint 由 close 完成）。
 */
const fs = require('node:fs');
const path = require('node:path');

const { createMissionControl, parseConfig, sqliteAvailable } = require('./index');

let VERSION = '0.0.0';
// 注意路径是 ../package.json：cli.js 在 src/ 下，package.json 在包根。
// 早先这里写成 ./package.json，解析到 src/package.json（不存在），
// 于是每次都走 catch 退回硬编码版本号——发版改了 package.json 也不见生效。
try {
  const pkg = require('../package.json');
  if (pkg && pkg.version) VERSION = pkg.version;
} catch { /* 源码树被裁剪时退回内置版本号 */ }

function printHelp() {
  process.stdout.write([
    '枢机 · Mission-Control — Agent 控制面',
    '',
    '用法：node src/cli.js [--check] [--version] [--help]',
    '',
    '必填环境变量：',
    '  MC_API_KEY          控制面 API Key（Bearer；bridge 与 sidecar 用同一个值）',
    '',
    '常用环境变量：',
    '  MC_HOST             监听地址，默认 127.0.0.1（绑 0.0.0.0 需 ALLOW_PUBLIC_BIND=1）',
    '  MC_PORT             监听端口，默认 3000',
    '  MC_DB               SQLite 路径，默认 ./mission-control.db',
    '  MC_AUDIT_LOG        审计 JSONL，默认 audit.jsonl（none 关闭）',
    '  MC_STALE_SEC        心跳超过该秒数无更新 → /list 报 offline，默认 900',
    '  MC_TASKS_PER_AGENT  每 Agent 保留任务数上限，默认 500',
    '  MC_HEARTBEATS_PER_AGENT  每 Agent 保留的心跳流水条数，默认 200（0 = 不清理，会告警）',
    '  MC_MAX_DETAIL_BYTES 心跳 detail 大小上限，默认 8192（防失灵的 Agent 撑爆库）',
    '  MC_RATE_LIMIT_PER_MIN / MC_RATE_LIMIT_BURST   每 IP 限流，默认 600 / 200',
    '  MC_PANEL            网页可视化面板开关，1 开 0 关，默认开（只读）',
    '  MC_PANEL_SESSION_TTL_MS   面板会话有效期，默认 43200000（12 小时）',
    '  MC_PANEL_LOGIN_PER_MIN    面板登录尝试限流，默认每 IP 每分钟 5 次',
    '  LOG_LEVEL           debug | info | warn | error，默认 info',
    '',
    '端点：',
    '  GET  /healthz  GET /statsz',
    '  GET  /api/agents  GET /api/agents/<id>  GET /api/agents/<id>/tasks',
    '  GET  /api/costs/summary',
    '  POST /api/agents/heartbeat  POST /api/tasks',
    '  POST /api/tasks/<id>/claim  POST /api/tasks/<id>/complete',
    '',
    '网页面板（只读）：',
    '  GET  /panel            面板页面（未登录时显示登录表单）',
    '  POST /panel/login      用 MC_API_KEY 换会话 Cookie',
    '  POST /panel/logout     作废会话 Cookie',
    '  GET  /panel/api/snapshot   面板数据（需会话）',
    '',
  ].join('\n'));
}

function checkOnly(env) {
  const { config, errors, warnings } = parseConfig(env);
  for (const w of warnings) process.stderr.write('[warn] ' + w + '\n');
  if (errors.length) {
    process.stderr.write('[fail] 配置不可用：\n');
    for (const e of errors) process.stderr.write('  - ' + e + '\n');
    return 2;
  }
  process.stdout.write(`[ok] 配置合法：${config.host}:${config.port} db=${config.dbPath}\n`);
  if (!sqliteAvailable()) {
    process.stderr.write(`[fail] 当前 Node ${process.version} 无 node:sqlite（需 22.5+ / 24）\n`);
    return 2;
  }
  const dir = path.dirname(config.dbPath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    process.stderr.write(`[fail] 数据库目录不可写：${dir}（${e.message}）\n`);
    return 2;
  }
  if (config.auditFile && config.auditFile !== 'none') {
    const adir = path.dirname(config.auditFile);
    try {
      if (!fs.existsSync(adir)) fs.mkdirSync(adir, { recursive: true, mode: 0o750 });
      fs.accessSync(adir, fs.constants.W_OK);
    } catch (e) {
      process.stderr.write(`[warn] 审计目录不可写：${adir}（${e.message}）\n`);
    }
  }
  process.stdout.write('[ok] 数据库与审计目录可写\n');
  return 0;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return 0; }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (argv.includes('--check')) return checkOnly(process.env);

  let mc;
  try {
    mc = createMissionControl({ env: process.env });
  } catch (e) {
    process.stderr.write('[fail] ' + (e && e.message ? e.message : String(e)) + '\n');
    return 2;
  }

  const { config, warnings } = mc;
  process.stdout.write([
    `枢机 · Mission-Control 已启动`,
    `  监听     http://${config.host}:${config.port}`,
    `  数据库   ${config.dbPath}`,
    `  审计     ${config.auditFile === 'none' ? '（已关闭）' : config.auditFile}`,
    `  心跳超时 ${config.staleSec}s 后 /list 报 offline`,
    `  PID      ${process.pid}`,
    ...(warnings.length ? warnings.map((w) => '  [warn] ' + w) : []),
  ].join('\n') + '\n');

  mc.listen(config.port, config.host).catch((e) => {
    process.stderr.write('[fail] 监听失败：' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(1);
  });

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n收到 ${sig}，优雅停机…\n`);
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref();
    try { await mc.close(); } catch { /* 忽略 */ }
    clearTimeout(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return undefined;
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') process.exit(code);
}

module.exports = { main };
