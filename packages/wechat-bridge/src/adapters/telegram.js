'use strict';
/**
 * 枢机 · Telegram 适配器（Bot API，long polling）。
 * 零第三方依赖；默认只处理文本消息，发送用 plain text（规避 Markdown 转义问题）。
 * 安全：只信 TELEGRAM_ALLOW_FROM 里的用户 id（数字）；桥整体仍只绑 127.0.0.1/Tailscale。
 *
 * 韧性：
 *   - 启动时可先 getMe 校验令牌（validateToken），失败不崩、交给轮询重试
 *   - 单条 update 处理失败不影响同批其余消息（offset 已先行推进，不会重复消费）
 *   - 指数退避 1s→30s；stop() 可被信号处理器调用，做到优雅停机
 *   - 每次调用带超时：连接被中间设备静默吞掉（黑洞）时，没有超时的 fetch 会
 *     无限期挂起，长轮询循环从此再也不转——表现是机器人在线但谁都不理。
 */
const MAX_BACKOFF_MS = 30000;
/** 普通调用（getMe / sendMessage）的超时。 */
const CALL_TIMEOUT_MS = 15000;
/** 长轮询在服务端 hold 满 pollTimeout 秒，客户端超时要留出网络余量。 */
const POLL_TIMEOUT_MARGIN_MS = 10000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createTelegramAdapter({
  router,
  token,
  apiBase = 'https://api.telegram.org',
  fetchImpl,
  pollTimeout = 30,
  drainBacklog = true,
  validateToken = false,
  sleepImpl = sleep,
  logger = console,
  onError,
} = {}) {
  if (!router) throw new Error('createTelegramAdapter 需要 router');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 未配置');
  const doFetch = fetchImpl || globalThis.fetch;
  const log = logger.error ? logger : { debug() {}, info() {}, warn() {}, error() {} };

  async function call(method, body, { signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 外部信号（停机用）与超时合并：任一触发都中断这次请求。
    // 定时器覆盖到响应体读完为止——AbortSignal 同样中断 res.json() 的读取。
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await doFetch(`${apiBase}/bot${encodeURIComponent(token)}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!data.ok) {
        const err = new Error(`Telegram ${method} 失败: ${JSON.stringify(data)}`);
        err.tgError = data;
        // Telegram 的 429 带 parameters.retry_after（秒）。它比我们自己的指数退避
        // 更权威——照它等，否则会在服务端还在限流期间反复撞墙。
        const retryAfter = data && data.parameters && Number(data.parameters.retry_after);
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = Math.ceil(retryAfter * 1000);
        throw err;
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getUpdates(offset, signal) {
    return call('getUpdates', {
      offset, timeout: pollTimeout, allowed_updates: ['message'],
    }, { signal, timeoutMs: pollTimeout * 1000 + POLL_TIMEOUT_MARGIN_MS });
  }

  async function sendMessage(chatId, text) {
    return call('sendMessage', {
      chat_id: chatId, text, disable_web_page_preview: true,
    });
  }

  async function handleUpdate(update) {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return null; // 非文本忽略
    // 只接私聊。机器人一旦被拉进群，群里每个人的消息都会走到这里：
    // 陌生成员会触发「拒绝访问」并**回进群里**——既刷屏，又等于向全群公告
    // 「这个机器人有白名单、以及谁不在名单里」。命令入口是单人通道，群场景走企业微信。
    if (msg.chat && msg.chat.type && msg.chat.type !== 'private') {
      log.debug('telegram: 忽略非私聊消息', { chatType: msg.chat.type, chatId: msg.chat.id });
      return null;
    }
    const from = msg.from ? String(msg.from.id) : '';
    const reply = await router.handle(msg.text, from, { channel: 'telegram' });
    await sendMessage(msg.chat.id, reply);
    return { from, chatId: msg.chat.id, reply };
  }

  function start({ offset = 0 } = {}) {
    let stopped = false;
    let cur = offset;
    let backoff = 1000;

    (async () => {
      if (validateToken) {
        try {
          const me = await call('getMe', {});
          log.info('telegram: 令牌校验通过', { bot: me && me.username });
        } catch (e) {
          log.warn('telegram: 令牌校验失败（继续重试）', { error: String(e && e.message || e) });
        }
      }
      // 启动时丢弃积压（宕机期间的消息不回放），避免对过期命令刷屏。
      // 注意 offset=-1 的语义是「只要最后一条更新」，所以这里拿到的是最后一条的
      // update_id；把 offset 推到它后面，中间的积压就整段跳过。日志说 skipped
      // 而不是 dropped=N——N 最多是 1，报个数会让人以为只丢了一条。
      if (drainBacklog) {
        try {
          const backlog = await getUpdates(-1);
          if (Array.isArray(backlog) && backlog.length > 0) {
            cur = backlog[backlog.length - 1].update_id + 1;
            log.info('telegram: 已跳过宕机期间积压', { offsetAdvancedTo: cur });
          }
        } catch (e) { /* 丢弃失败不阻塞启动 */ }
      }
      log.info('telegram: 开始长轮询', { apiBase });
      while (!stopped) {
        try {
          const updates = await getUpdates(cur);
          backoff = 1000;
          for (const u of (updates || [])) {
            cur = u.update_id + 1; // 先推进 offset：失败也不重复消费
            if (stopped) break;
            try {
              await handleUpdate(u);
            } catch (e) {
              onError ? onError(e) : log.error('telegram: 消息处理失败', { error: String(e && e.message || e) });
            }
          }
        } catch (e) {
          if (stopped) break;
          onError ? onError(e) : log.warn('telegram poll 失败：' + e.message);
          // 服务端明确要求等多久就等多久（429 的 retry_after），否则用自己的退避
          const wait = e && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0
            ? e.retryAfterMs
            : backoff;
          await sleepImpl(wait);
          if (wait >= backoff) backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          else backoff = 1000; // 按服务端指示等过一次，退回初始值
        }
      }
      log.info('telegram: 长轮询已停止');
    })();

    return {
      stop() { stopped = true; },
      get offset() { return cur; },
      get stopped() { return stopped; },
    };
  }

  return { call, getUpdates, sendMessage, handleUpdate, start };
}

module.exports = { createTelegramAdapter };
