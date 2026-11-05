#!/usr/bin/env node
'use strict';
/**
 * 枢机 · 命令路由 CLI
 *   wechat-bridge --adapter http  --port 8080   # 通用 HTTP（测试/其他平台）
 *   wechat-bridge --adapter wecom --port 8080   # 企业微信自建应用回调
 * 配置全部走环境变量（红线：密钥不入库不入镜像），见 deploy/env/wechat-bridge.env.example
 */
const { createBridgeFromEnv } = require('./index');

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

const args = parseArgs(process.argv);
if (args.adapter) process.env.ADAPTER = args.adapter;
if (args.port) process.env.PORT = args.port;
if (args.host) process.env.HOST = args.host;

try {
  const bridge = createBridgeFromEnv(process.env);
  const adapter = (process.env.ADAPTER || 'http').toLowerCase();
  if (bridge.server) {
    bridge.server.on('listening', () => {
      const addr = bridge.server.address();
      process.stdout.write(
        `wechat-bridge 已启动 adapter=${adapter} ` +
        `listen=${addr.address}:${addr.port} 白名单=${process.env.WECHAT_ALLOW_FROM || process.env.TELEGRAM_ALLOW_FROM}\n`);
    });
  } else {
    process.stdout.write(
      `wechat-bridge 已启动 adapter=${adapter}（long polling，无监听端口）` +
      ` 白名单=${process.env.WECHAT_ALLOW_FROM || process.env.TELEGRAM_ALLOW_FROM}\n`);
  }
} catch (e) {
  process.stderr.write('启动失败：' + e.message + '\n');
  process.exit(1);
}
