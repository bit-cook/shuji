#!/usr/bin/env node
'use strict';
/**
 * 枢机 · 命令路由 CLI
 *   wechat-bridge --adapter http       --port 8080   # 通用 HTTP（OpenClaw 插件 / 人工排查）
 *   wechat-bridge --adapter telegram                 # Telegram 长轮询（无监听端口）
 *   wechat-bridge --adapter wecom     --port 8080    # 企业微信自建应用回调
 *   wechat-bridge --adapter weixin                 # 微信（iLink）长轮询（无监听端口）
 *   wechat-bridge --adapter weixin --login          # 微信扫码登录（一次性交互步骤）
 *   wechat-bridge --check                           # 只校验配置，不启动
 * 配置全部走环境变量（红线：密钥不入库不入镜像），见 deploy/env/wechat-bridge.env.example
 */
const fs = require('node:fs');
const path = require('node:path');
const { createBridgeFromEnv, validateConfig, runWeixinLogin } = require('./index');

const USAGE = `枢机 · 命令路由（wechat-bridge）

用法：
  wechat-bridge [--adapter http|telegram|wecom|weixin] [--host H] [--port P] [--check]
  wechat-bridge --adapter weixin --login            # 微信扫码登录（一次性）
  wechat-bridge --help | --version

环境变量（全部可选默认见 deploy/env/wechat-bridge.env.example）：
  WECHAT_ALLOW_FROM / TELEGRAM_ALLOW_FROM   命令入口白名单（红线，至少一项）
  MC_BASE / MC_API_KEY                      管理面地址与 API Key
  ADAPTER / HOST / PORT                     入口适配器与监听地址（默认 http / 127.0.0.1 / 8080）
  BRIDGE_TOKEN                              HTTP 端点 Bearer 令牌（配置后强制鉴权）
  AUDIT_LOG                                 审计日志路径（默认 audit.jsonl；none 关闭）
  CONFIRM_TTL_MS / RATE_LIMIT_PER_MIN / RATE_LIMIT_BURST

微信（ADAPTER=weixin）：
  WECHAT_BOT_TOKEN                          已登录得到的机器人令牌（也可由 --login 写入状态文件）
  WECHAT_STATE_FILE                         令牌与同步游标持久化路径（绝对路径，0600）
  WECHAT_API_BASE / WECHAT_BOT_TYPE         接入点 / 机器人类型（默认 3）
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

// 微信扫码登录：一次性交互步骤，与「启动长轮询」分开。
// systemd 单元里没有人扫码，所以登录只能在有终端的机器上手动跑一次，
// 产物（bot_token + 接入点 + 同步游标）落进 WECHAT_STATE_FILE（0600）。
if (args.login) {
  if (adapter !== 'weixin') {
    process.stderr.write('--login 只用于 ADAPTER=weixin（扫码登录拿到机器人令牌）\n');
    process.exit(1);
  }
  const stateFile = process.env.WECHAT_STATE_FILE;
  if (!stateFile || !path.isAbsolute(stateFile)) {
    process.stderr.write('扫码登录需要 WECHAT_STATE_FILE 为绝对路径（令牌是机密，不接受相对路径）\n');
    process.exit(1);
  }
  let qrcodeTerminal;
  try {
    qrcodeTerminal = require('qrcode-terminal');
  } catch {
    qrcodeTerminal = null; // 没装依赖也能登录：降级为打印二维码链接
  }
  const readLine = (prompt) => new Promise((resolve) => {
    process.stdout.write(prompt);
    let input = '';
    const onData = (chunk) => {
      input += chunk.toString();
      if (input.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
  runWeixinLogin({
    apiBase: process.env.WECHAT_API_BASE || undefined,
    botType: process.env.WECHAT_BOT_TYPE || undefined,
    stateFile,
    print: (t) => process.stdout.write(t),
    showQr: (url) => {
      if (qrcodeTerminal) {
        qrcodeTerminal.generate(url, { small: true });
        process.stdout.write('\n若二维码无法显示或无法使用，可访问这个链接继续：\n' + url + '\n');
      } else {
        process.stdout.write('二维码链接（用手机微信打开）：\n' + url + '\n');
      }
    },
    readVerifyCode: (prompt) => readLine(prompt),
    timeoutMs: Number(process.env.WECHAT_LOGIN_TIMEOUT_MS) || 480000,
  }).then((result) => {
    process.stdout.write('\n登录成功。\n');
    if (result.userId) {
      process.stdout.write(`扫码账号 ID：${result.userId}\n`);
      process.stdout.write(`把这个 ID 加进 WECHAT_ALLOW_FROM，否则白名单会拒绝它：\n`);
      process.stdout.write(`  WECHAT_ALLOW_FROM=${process.env.WECHAT_ALLOW_FROM ? process.env.WECHAT_ALLOW_FROM + ',' + result.userId : result.userId}\n`);
    }
    if (result.alreadyConnected) {
      process.stdout.write('（这个机器人此前已连接到枢机，令牌未变更）\n');
    }
    process.exit(0);
  }).catch((e) => {
    process.stderr.write('登录失败：' + String(e && e.message || e) + '\n');
    process.exit(1);
  });
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
