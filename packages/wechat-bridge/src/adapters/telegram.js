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
 */
const MAX_BACKOFF_MS = 30000;

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

  async function call(method, body, signal) {
    const res = await doFetch(`${apiBase}/bot${encodeURIComponent(token)}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal,
    });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(`Telegram ${method} 失败: ${JSON.stringify(data)}`);
      err.tgError = data;
      throw err;
    }
    return data.result;
  }

  async function getUpdates(offset, signal) {
    return call('getUpdates', {
      offset, timeout: pollTimeout, allowed_updates: ['message'],
    }, signal);
  }

  async function sendMessage(chatId, text) {
    return call('sendMessage', {
      chat_id: chatId, text, disable_web_page_preview: true,
    });
  }

  async function handleUpdate(update) {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return null; // 非文本忽略
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
      // 启动时丢弃积压（宕机期间的消息不回放），避免对过期命令刷屏
      if (drainBacklog) {
        try {
          const backlog = await getUpdates(-1);
          if (Array.isArray(backlog) && backlog.length > 0) {
            cur = backlog[backlog.length - 1].update_id + 1;
            log.info('telegram: 丢弃宕机期间积压', { dropped: backlog.length });
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
          await sleepImpl(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
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
