'use strict';
/**
 * 枢机 · Telegram 适配器（Bot API，long polling）。
 * 零第三方依赖；默认只处理文本消息，发送用 plain text（规避 Markdown 转义问题）。
 * 安全：只信 TELEGRAM_ALLOW_FROM 里的用户 id（数字）；桥整体仍只绑 127.0.0.1/Tailscale。
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
  sleepImpl = sleep,
  logger = console,
  onError,
} = {}) {
  if (!router) throw new Error('createTelegramAdapter 需要 router');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 未配置');
  const doFetch = fetchImpl || globalThis.fetch;

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
      // 启动时丢弃积压（宕机期间的消息不回放），避免对过期命令刷屏
      if (drainBacklog) {
        try {
          const backlog = await getUpdates(-1);
          if (Array.isArray(backlog) && backlog.length > 0) {
            cur = backlog[backlog.length - 1].update_id + 1;
            logger.log && logger.log(`telegram: 丢弃积压 ${backlog.length} 条`);
          }
        } catch (e) { /* 丢弃失败不阻塞启动 */ }
      }
      while (!stopped) {
        try {
          const updates = await getUpdates(cur);
          backoff = 1000;
          for (const u of (updates || [])) {
            cur = u.update_id + 1;
            if (stopped) break;
            await handleUpdate(u);
          }
        } catch (e) {
          if (stopped) break;
          onError ? onError(e) : logger.warn('telegram poll 失败：' + e.message);
          await sleepImpl(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    })();

    return {
      stop() { stopped = true; },
      get offset() { return cur; },
    };
  }

  return { call, getUpdates, sendMessage, handleUpdate, start };
}

module.exports = { createTelegramAdapter };
