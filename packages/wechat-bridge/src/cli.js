#!/usr/bin/env node
'use strict';
/**
 * 枢机 · 命令路由 CLI
 *   wechat-bridge --adapter http       --port 8080   # 通用 HTTP（OpenClaw 插件 / 人工排查）
 *   wechat-bridge --adapter telegram                 # Telegram 长轮询（无监听端口）
 *   wechat-bridge --adapter wecom     --port 8080    # 企业微信自建应用回调
 *   wechat-bridge --check                           # 只校验配置，不启动
 * 配置全部走环境变量（红线：密钥不入库不入镜像），见 deploy/env/wechat-bridge.env.example
 */
const fs = require('node:fs');
const path = require('node:path');
const { createBridgeFromEnv, validateConfig } = require('./index');

const USAGE = `枢机 · 命令路由（wechat-bridge）

用法：
  wechat-bridge [--adapter http|telegram|wecom] [--host H] [--port P] [--check]
  wechat-bridge --help | --version

环境变量（全部可选默认见 deploy/env/wechat-bridge.env.example）：
  WECHAT_ALLOW_FROM / TELEGRAM_ALLOW_FROM   命令入口白名单（红线，至少一项）
  MC_BASE / MC_API_KEY                      管理面地址与 API Key
  ADAPTER / HOST / PORT                     入口适配器与监听地址（默认 http / 127.0.0.1 / 8080）
  BRIDGE_TOKEN                              HTTP 端点 Bearer 令牌（配置后强制鉴权）
  AUDIT_LOG                                 审计日志路径（默认 audit.jsonl；none 关闭）
  CONFIRM_TTL_MS / RATE_LIMIT_PER_MIN / RATE_LIMIT_BURST
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    }
  }
  return out;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch { return 'unknown'; }
}

const args = parseArgs(process.argv);

if (args.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
if (args.version) { process.stdout.write(packageVersion() + '\n'); process.exit(0); }
if (args.adapter) process.env.ADAPTER = args.adapter;
if (args.port) process.env.PORT = args.port;
if (args.host) process.env.HOST = args.host;

const adapter = String(process.env.ADAPTER || 'http').toLowerCase();

if (args.check) {
  const r = validateConfig(process.env);
  for (const w of r.warnings) process.stdout.write('[warn] ' + w + '\n');
  for (const e of r.errors) process.stderr.write('[error] ' + e + '\n');
  process.stdout.write(r.ok
    ? `配置校验通过（adapter=${r.adapter} 白名单 ${r.allowFrom.length} 人）\n`
    : `配置校验失败：${r.errors.length} 个问题\n`);
  process.exit(r.ok ? 0 : 1);
}

let bridge;
try {
  bridge = createBridgeFromEnv(process.env);
} catch (e) {
  process.stderr.write('启动失败：' + e.message + '\n');
  process.exit(1);
}

const logger = bridge.logger || console;

if (bridge.server) {
  bridge.server.on('listening', () => {
    const addr = bridge.server.address();
    const allow = process.env.WECHAT_ALLOW_FROM || process.env.TELEGRAM_ALLOW_FROM || '';
    logger.info('wechat-bridge 已启动', {
      adapter, listen: `${addr.address}:${addr.port}`, allowFrom: allow,
      auth: process.env.BRIDGE_TOKEN ? 'bearer' : 'none',
    });
  });
} else {
  logger.info('wechat-bridge 已启动', {
    adapter, listen: 'none (long polling)',
    allowFrom: process.env.WECHAT_ALLOW_FROM || process.env.TELEGRAM_ALLOW_FROM || '',
  });
}

// 优雅停机：SIGTERM/SIGINT → 停轮询、关监听、退出（systemd / docker stop 友好）
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info('收到停机信号', { signal });
  const done = () => process.exit(0);
  try {
    if (bridge.polling) bridge.polling.stop();
    if (bridge.server) {
      if (bridge.server.closeAllConnections) bridge.server.closeAllConnections();
      bridge.server.close(() => done());
      setTimeout(done, 3000).unref();
    } else {
      done();
    }
  } catch (e) {
    logger.error('停机异常', { error: String(e && e.message || e) });
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
