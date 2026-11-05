'use strict';
/**
 * 枢机 · 微信扫码登录流程（iLink）。
 *
 * 只在交互式终端里运行一次：wechat-bridge --adapter weixin --login。
 * 登录产物是服务端签发的 bot_token 与 ilink_bot_id，连同 getupdates 用的接入点
 * 一起持久化到状态文件（0600）。之后 systemd 单元只做长轮询，不需要人在场。
 *
 * 状态机完全照对端实际返回的 status 字段（wait / scaned / need_verifycode /
 * expired / verify_code_blocked / binded_redirect / scaned_but_redirect /
 * confirmed）逐分支处理，没有推测出来的分支：
 *   - scaned_but_redirect 带 redirect_host：接入点要切到 https://<redirect_host>，
 *     否则后续轮询打到旧机房，表现为扫了码但一直没下文。
 *   - binded_redirect 表示这个机器人已经绑到枢机名下，服务端不再发新令牌——
 *     这属于成功（已有令牌继续有效），不是失败。
 *   - confirmed 才带 bot_token 与 ilink_bot_id；后者就是机器人的身份 ID。
 */
const { createIlinkClient } = require('./ilink');
const { writeState } = require('./adapters/weixin');

const QR_TTL_MS = 5 * 60 * 1000;
const MAX_QR_REFRESH = 3;
const POLL_GAP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} [opts.apiBase]     初始接入点
 * @param {string} opts.stateFile     持久化路径
 * @param {string} [opts.botType]     默认 3
 * @param {Function} opts.fetchImpl
 * @param {(url: string) => any} [opts.showQr]  二维码展示（CLI 注入 qrcode-terminal）
 * @param {(text: string) => void} [opts.print]
 * @param {() => Promise<string>} [opts.readVerifyCode]  读手机微信上显示的数字
 * @param {number} [opts.timeoutMs]
 * @param {(ms: number) => Promise<void>} [opts.sleepImpl]
 */
async function runWeixinLogin(opts = {}) {
  const {
    apiBase, stateFile, botType, fetchImpl, showQr, print = () => {},
    readVerifyCode, timeoutMs = 480000, sleepImpl = sleep, logger = console,
  } = opts;
  const log = logger.error ? logger : { debug() {}, info() {}, warn() {}, error() {} };

  let currentBase = apiBase || undefined;
  const client = createIlinkClient({ baseUrl: currentBase, fetchImpl, logger: log });
  const deadline = Date.now() + Math.max(timeoutMs, 1000);

  const qr = await client.fetchQrCode(botType);
  let qrcode = qr && (qr.qrcode || qr.qrcode_url);
  if (!qrcode) {
    throw new Error(`iLink 未返回二维码：${JSON.stringify(qr).slice(0, 200)}`);
  }
  const qrcodeUrl = (qr.qrcode_img_content || qrcode);
  let refreshCount = 1;
  let pendingVerifyCode = '';
  let scannedPrinted = false;

  if (showQr) showQr(qrcodeUrl); else print('二维码链接：' + qrcodeUrl + '\n');

  while (Date.now() < deadline) {
    const st = await client.pollQrStatus(qrcode, {
      verifyCode: pendingVerifyCode || undefined,
      signal: undefined,
    });
    log.debug('login: qr status', { status: st && st.status });

    switch (st && st.status) {
      case 'scaned':
        if (pendingVerifyCode) pendingVerifyCode = '';
        if (!scannedPrinted) { print('\n已在手机上确认，等待服务端签发令牌\n'); scannedPrinted = true; }
        break;
      case 'need_verifycode': {
        if (!readVerifyCode) {
          throw new Error('服务端要求输入配对数字，但当前不是交互式终端。请在有 tty 的终端里执行 --login');
        }
        pendingVerifyCode = await readVerifyCode(
          pendingVerifyCode ? '上一次输入的数字不匹配，请重新输入：' : '输入手机微信上显示的数字，以继续连接：');
        continue; // 立即再轮一次，不空等
      }
      case 'scaned_but_redirect': {
        const host = st.redirect_host;
        if (host) {
          currentBase = `https://${host}`;
          client.setBaseUrl(currentBase);
          log.info('login: 接入点重定向', { redirectHost: host });
        } else {
          log.warn('login: scaned_but_redirect 未带 redirect_host，继续用当前接入点');
        }
        break;
      }
      case 'expired':
      case 'verify_code_blocked': {
        pendingVerifyCode = '';
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH) {
          throw new Error('二维码多次失效，登录流程已停止，请稍后再试');
        }
        print(`\n二维码已过期，正在刷新（第 ${refreshCount}/${MAX_QR_REFRESH} 次）\n`);
        const next = await client.fetchQrCode(botType);
        const nextUrl = next && (next.qrcode_img_content || next.qrcode || next.qrcode_url);
        if (!nextUrl) throw new Error('刷新二维码失败：响应里没有二维码');
        scannedPrinted = false;
        if (showQr) showQr(nextUrl); else print('二维码链接：' + nextUrl + '\n');
        // 新的二维码要作为 qrcode 参数继续轮询
        qrcode = next.qrcode || next.qrcode_url || qrcode;
        break;
      }
      case 'binded_redirect':
        print('\n这个机器人已经连接到枢机，服务端未签发新令牌；已有令牌继续有效。\n');
        return { connected: true, alreadyConnected: true, message: 'already bound' };
      case 'confirmed': {
        if (!st.ilink_bot_id) {
          throw new Error('登录已确认但服务端未返回 ilink_bot_id');
        }
        if (stateFile) {
          writeState(stateFile, {
            token: st.bot_token,
            botId: st.ilink_bot_id,
            userId: st.ilink_user_id || '',
            baseUrl: st.baseurl || currentBase || client.baseUrl,
            botType: botType || undefined,
            getUpdatesBuf: '',
            updatedAt: new Date().toISOString(),
          });
          log.info('login: 令牌已写入状态文件', { stateFile, mode: '0600' });
        }
        return {
          connected: true,
          botToken: st.bot_token,
          botId: st.ilink_bot_id,
          userId: st.ilink_user_id || '',
          baseUrl: st.baseurl || currentBase || client.baseUrl,
        };
      }
      case 'wait':
      default:
        break;
    }
    await sleepImpl(POLL_GAP_MS);
  }
  throw new Error('登录超时（' + Math.round(timeoutMs / 1000) + ' 秒内未完成扫码），请重试');
}

module.exports = { runWeixinLogin, QR_TTL_MS, MAX_QR_REFRESH };
