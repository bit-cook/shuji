'use strict';
/**
 * 枢机 · 微信（iLink）适配器。
 *
 * 定位：这是「第 N 个入口」这个模式里的一个实例。适配器只负责把某个通讯工具的
 * 私聊文本翻译成 router.handle(text, from, {channel})，再把 router 返回的字符串
 * 发回去。白名单、命令协议、危险命令二次确认、审计、限流全部在 router 里，
 * 适配器一条都不重复实现——新增通道时只需要写一个这种文件。
 *
 * 与 Telegram 适配器的同构点：出站长轮询、指数退避、优雅停机。
 * 与 Telegram 的不同点：
 *   - 令牌不是环境变量给的，而是扫码登录后由服务端签发、由枢机持久化到磁盘
 *     （0600）。环境变量里仍然可以塞 WECHAT_BOT_TOKEN 直接复用已有令牌。
 *   - 有服务端同步游标 get_updates_buf，必须原样回传并持久化，否则重启后
 *     服务端会重放积压消息（表现为把用户下线期间发的命令重新执行一遍）。
 *   - 群聊判定看 group_id 是否为空串。
 */
const fs = require('node:fs');
const { createIlinkClient, extractTextMessages } = require('../ilink');

const MAX_BACKOFF_MS = 30000;
/** 游标落盘节流：长轮询每 35 秒一轮，没必要每次全量写盘，但也别让崩溃丢太多。 */
const STATE_FLUSH_INTERVAL_MS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读取持久化的登录态。文件不存在或损坏都按「未登录」处理，由上层引导去扫码。 */
function readState(file) {
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.token !== 'string' || !data.token.trim()) return null;
    return data;
  } catch {
    return null;
  }
}

/** 原子写入：先写同目录临时文件再 rename，避免崩溃时留下半截 JSON。 */
function writeState(file, data) {
  if (!file) return;
  const dir = require('node:path').dirname(file);
  const tmp = file + '.tmp';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 文件系统不支持时尽力而为 */ }
}

function createWeixinAdapter({
  router,
  token,
  stateFile,
  apiBase,
  botType,
  fetchImpl,
  logger = console,
  onError,
  sleepImpl = sleep,
  pollTimeoutMs = 35000,
} = {}) {
  if (!router) throw new Error('createWeixinAdapter 需要 router');
  const log = logger.error ? logger : { debug() {}, info() {}, warn() {}, error() {} };

  let baseUrl = apiBase || undefined;
  let currentToken = token || '';
  let buf = '';
  const stored = readState(stateFile);
  if (stored) {
    if (!currentToken) currentToken = stored.token;
    if (!baseUrl && stored.baseUrl) baseUrl = stored.baseUrl;
    if (stored.getUpdatesBuf) buf = stored.getUpdatesBuf;
  }

  const client = createIlinkClient({
    baseUrl,
    token: currentToken,
    botType,
    fetchImpl,
    logger: log,
  });
  if (!currentToken) {
    log.error('weixin: 未登录（没有令牌）。先执行 wechat-bridge --adapter weixin --login 完成扫码登录');
  }

  let lastFlush = 0;
  function persist(force) {
    if (!stateFile) return;
    const now = Date.now();
    if (!force && now - lastFlush < STATE_FLUSH_INTERVAL_MS) return;
    lastFlush = now;
    writeState(stateFile, {
      token: currentToken, baseUrl: client.baseUrl, getUpdatesBuf: buf, updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 处理一条用户文本消息。群聊显式忽略：机器人一旦被拉进群，群内每个成员的
   * 命令都会走到这里，陌生成员会收到「拒绝访问」并回在群里——既刷屏，
   * 又等于向全群公告「这个机器人有白名单」。命令入口是单人通道。
   */
  async function handleMessage(msg) {
    if (msg.groupId) {
      log.debug('weixin: 忽略群聊消息', { groupId: msg.groupId, from: msg.from });
      return null;
    }
    const reply = await router.handle(msg.text, msg.from, { channel: 'weixin' });
    await client.sendText(msg.from, reply, { token: currentToken, contextToken: msg.contextToken });
    return { from: msg.from, messageId: msg.messageId, reply };
  }

  /** 服务端可能通过登录态下发新的 baseurl；这里在运行中切换端点。 */
  function applyBaseUrl(next) {
    if (!next || typeof next !== 'string') return;
    if (next.replace(/\/+$/, '') === client.baseUrl) return;
    log.info('weixin: 服务端下发新接入点', { baseUrl: next });
    client.setBaseUrl(next);
    baseUrl = next;
  }

  function start() {
    let stopped = false;
    let backoff = 1000;
    const controller = new AbortController();

    (async () => {
      if (!currentToken) {
        log.error('weixin: 无令牌，长轮询未启动。请先 --login');
        return;
      }
      log.info('weixin: 开始长轮询', { apiBase: client.baseUrl, stateFile: stateFile || '(none)' });
      while (!stopped) {
        try {
          const resp = await client.getUpdates(buf, {
            signal: controller.signal,
            timeoutMs: pollTimeoutMs,
          });
          backoff = 1000;
          if (resp && typeof resp.get_updates_buf === 'string' && resp.get_updates_buf !== buf) {
            buf = resp.get_updates_buf;
            persist(false);
          }
          if (resp && resp.baseurl) applyBaseUrl(resp.baseurl);
          for (const m of extractTextMessages(resp && resp.msgs)) {
            if (stopped) break;
            try {
              await handleMessage(m);
            } catch (e) {
              onError ? onError(e) : log.error('weixin: 消息处理失败', { error: String(e && e.message || e) });
            }
          }
        } catch (e) {
          if (stopped) break;
          onError ? onError(e) : log.warn('weixin getupdates 失败：' + String(e && e.message || e));
          await sleepImpl(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
      persist(true);
      log.info('weixin: 长轮询已停止');
    })();

    return {
      stop() {
        stopped = true;
        controller.abort();
        persist(true);
      },
      get getUpdatesBuf() { return buf; },
      get stopped() { return stopped; },
      get loggedIn() { return Boolean(currentToken); },
    };
  }

  return {
    client, handleMessage, start, persist,
    sendText: (to, text) => client.sendText(to, text, { token: currentToken }),
    /** 令牌刷新后（重新登录）写回状态文件。 */
    setToken(next, { baseUrl: newBase } = {}) {
      currentToken = next;
      if (newBase) client.setBaseUrl(newBase);
      client.setToken(next);
      persist(true);
    },
    get token() { return currentToken; },
    get baseUrl() { return client.baseUrl; },
  };
}

module.exports = { createWeixinAdapter, readState, writeState };
