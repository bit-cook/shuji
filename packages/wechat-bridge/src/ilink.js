'use strict';
/**
 * 枢机 · iLink 协议客户端（微信机器人官方通道）。
 *
 * 为什么枢机自己实现一遍：微信入口不应以「先装好 OpenClaw」为前提。参照 OpenClaw
 * 官方微信通道（@tencent-weixin/openclaw-weixin）的连接方式，把底层协议直接实现在
 * 枢机里——它本来就是普通 HTTP + 长轮询，和 Telegram 适配器同构，没有理由依赖一个
 * 完整的 Agent 宿主。
 *
 * 协议要点（全部来自对端行为，不是猜测）：
 *   base          https://ilinkai.weixin.qq.com（登录成功后服务端可能下发新 baseurl）
 *   扫码登录      POST ilink/bot/get_bot_qrcode?bot_type=3   → { qrcode, ... }
 *                 GET  ilink/bot/get_qrcode_status?qrcode=…  （长轮询）→ { status, token, baseurl }
 *   收消息        POST ilink/bot/getupdates   { get_updates_buf, base_info }
 *                   → { ret, msgs[], get_updates_buf, longpolling_timeout_ms }
 *   发消息        POST ilink/bot/sendmessage  { msg, base_info } → { message_id, ret, errmsg }
 *   鉴权          Authorization: Bearer <token> + AuthorizationType: ilink_bot_token
 *
 * 两个必须照做的细节，否则会静默出错：
 *   1. message_id / msg_id / svr_id 是 uint64，超出 2^53 后 JS number 会丢精度。
 *      对端的 JSON 里它们是裸数字，直接 JSON.parse 就把 ID 改了——所以先把这些字段
 *      替换成字符串再解析（见 parseLossless）。
 *   2. get_updates_buf 是服务端的同步游标，必须原样回传。丢了它服务端会重放积压。
 */
const crypto = require('node:crypto');

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const LONG_POLL_TIMEOUT_MS = 35000;
const API_TIMEOUT_MS = 15000;
const CONFIG_TIMEOUT_MS = 10000;
/** 对端用这个头识别接入方身份（OpenClaw 官方通道的值就是 "bot"）。 */
const ILINK_APP_ID = 'bot';
/** 对端通过 base_info 看到枢机的版本号，便于排查。 */
const CHANNEL_VERSION = bridgeVersion();
/** base_info.bot_agent，UA 风格的自描述串。 */
const BOT_AGENT = 'cardinal-wechat-bridge/' + bridgeVersion();

/** uint64 字段：这些在 JSON 里是裸数字，必须按字符串读才不会丢精度。 */
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/** 消息体类型（item_list[].type）。枢机只处理文本，其余显式忽略。 */
const ITEM_TYPE = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
/** 消息方向：1=用户发来，2=机器人发出。只处理 1。 */
const MSG_TYPE = { NONE: 0, USER: 1, BOT: 2 };

/**
 * 把指定字段的数字替换成字符串再 JSON.parse。
 * 只改真正的对象属性，不碰字符串内容里的同名字样。
 */
function parseLossless(rawText) {
  let out = '';
  let i = 0;
  while (i < rawText.length) {
    if (rawText[i] !== '"') { out += rawText[i++]; continue; }
    const strStart = i;
    i++;
    let escaped = false;
    while (i < rawText.length) {
      const ch = rawText[i++];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') break;
    }
    const strToken = rawText.slice(strStart, i);
    out += strToken;

    let c = i;
    while (/\s/.test(rawText[c] ?? '')) c++;
    if (rawText[c] !== ':') continue;

    let key;
    try { key = JSON.parse(strToken); } catch { continue; }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;

    out += rawText.slice(i, c + 1);
    c++;
    while (/\s/.test(rawText[c] ?? '')) c++;
    const numStart = c;
    if (rawText[c] === '-') c++;
    while (/\d/.test(rawText[c] ?? '')) c++;
    // 形如 "-" 或空的不动；单字符 "0" 也保留原样（避免把 0 变成 "0" 引起类型意外）
    if (c > numStart && !(c === numStart + 1 && rawText[numStart] === '-')) {
      out += `"${rawText.slice(numStart, c)}"`;
      i = c;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out);
}

function randomUinB64() {
  return Buffer.from(crypto.randomBytes(4).readUInt32BE(0).toString(10), 'utf8').toString('base64');
}

/** 读本包 version，作为 iLink-App-ClientVersion 与 base_info 的版本来源。 */
function bridgeVersion() {
  try {
    const pkg = JSON.parse(require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
}

/** iLink-App-ClientVersion 的编码：uint32 的 0x00MMNNPP（高 8 位固定为 0）。 */
function encodeClientVersion(version) {
  const p = String(version).split('.').map((x) => Number.parseInt(x, 10));
  const major = Number.isFinite(p[0]) ? p[0] : 0;
  const minor = Number.isFinite(p[1]) ? p[1] : 0;
  const patch = Number.isFinite(p[2]) ? p[2] : 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function createIlinkClient({
  baseUrl = DEFAULT_BASE,
  token = '',
  fetchImpl,
  timeoutMs = API_TIMEOUT_MS,
  logger = console,
  botAgent = 'cardinal',
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前 Node 无全局 fetch（需要 Node 18+），或注入 fetchImpl');
  }
  const log = logger.error ? logger : { debug() {}, info() {}, warn() {}, error() {} };
  let root = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  let authToken = String(token || '').trim();

  function headers(withToken) {
    const h = {
      'Content-Type': 'application/json',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(encodeClientVersion(CHANNEL_VERSION)),
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomUinB64(),
    };
    // 调用方可以按次覆盖令牌（登录态刷新时用）；不传就用构造时那个。
    const t = String(withToken !== undefined && withToken !== null ? withToken : authToken).trim();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  async function call(endpoint, body, { token: tok, timeoutMs: to = timeoutMs, method = 'POST', signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), to);
    // 外部信号（停机用）与超时合并
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await doFetch(root + '/' + endpoint, {
        method,
        headers: headers(tok),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try { data = parseLossless(text); } catch { data = { ret: -1, errmsg: 'bad json: ' + text.slice(0, 120) }; }
      if (!res.ok && (data == null || data.ret === undefined)) {
        const err = new Error(`iLink ${endpoint} HTTP ${res.status}`);
        err.httpStatus = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get baseUrl() { return root; },
    /** 运行中切换接入点（登录时服务端可能下发新的 baseurl）。 */
    setBaseUrl(next) {
      if (!next || typeof next !== 'string') return;
      root = String(next).replace(/\/+$/, '');
    },
    /** 令牌刷新后换用新令牌（不重建客户端，轮询循环不用跟着改）。 */
    setToken(next) {
      authToken = String(next || '').trim();
    },
    call,
    headers,

    /** 取登录二维码（URL）。bot_type 默认 3。 */
    async fetchQrCode(botType = DEFAULT_BOT_TYPE, localTokenList = []) {
      const data = await call(
        `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        { local_token_list: localTokenList },
        { timeoutMs: API_TIMEOUT_MS },
      );
      return data;
    },

    /** 长轮询扫码状态。超时/网络错一律返回 { status: 'wait' }，由调用方继续轮。 */
    async pollQrStatus(qrcode, { verifyCode, timeoutMs = LONG_POLL_TIMEOUT_MS, signal } = {}) {
      let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`;
      try {
        return await call(ep, undefined, { timeoutMs, method: 'GET', signal });
      } catch (e) {
        if (e && e.name === 'AbortError') return { status: 'wait' };
        log.debug('pollQrStatus 网络错误，继续等', { error: String(e && e.message || e) });
        return { status: 'wait' };
      }
    },

    /**
     * 收消息（长轮询）。客户端超时是正常控制流：返回空响应让调用方立刻再轮，
     * 与 Telegram 适配器同构。get_updates_buf 原样带回。
     * ret 非 0 是服务端的错误应答，按异常抛出交给退避逻辑——把它当「没有消息」
     * 会让令牌失效、账号被封这类故障表现为「机器人在线但谁都不理」。
     */
    async getUpdates(getUpdatesBuf = '', { signal, timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
      try {
        const resp = await call('ilink/bot/getupdates', {
          get_updates_buf: getUpdatesBuf || '',
          base_info: { channel_version: CHANNEL_VERSION, bot_agent: botAgent || BOT_AGENT },
        }, { timeoutMs, signal });
        const ret = resp && resp.ret;
        if (ret !== undefined && ret !== null && Number(ret) !== 0) {
          const err = new Error(`getupdates ret=${ret} errmsg=${(resp && resp.errmsg) || '(none)'}`);
          err.ilink = resp;
          throw err;
        }
        return resp;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        }
        throw e;
      }
    },

    /** 发一条文本消息给指定用户。 */
    async sendText(toUserId, text, { token: tok, contextToken } = {}) {
      const msg = {
        to_user_id: String(toUserId),
        message_type: MSG_TYPE.BOT,
        item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: String(text) } }],
      };
      if (contextToken) msg.context_token = contextToken;
      const resp = await call('ilink/bot/sendmessage', { msg }, { token: tok });
      if (resp && resp.ret && resp.ret !== 0) {
        const err = new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`);
        err.ilink = resp;
        throw err;
      }
      return resp;
    },
  };
}

/** 从 getupdates 的 msgs 里取出「用户发来的文本」。非文本/机器人自己的消息一律忽略。 */
function extractTextMessages(msgs) {
  const out = [];
  for (const m of (msgs || [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.message_type !== undefined && m.message_type !== MSG_TYPE.USER) continue;
    const from = m.from_user_id ? String(m.from_user_id) : '';
    if (!from) continue;
    let text = '';
    for (const item of (m.item_list || [])) {
      if (!item || item.type !== ITEM_TYPE.TEXT) continue;
      if (item.text_item && typeof item.text_item.text === 'string') text += item.text_item.text;
    }
    if (!text.trim()) continue; // 图片/语音/文件：枢机命令协议是纯文本，显式忽略
    out.push({
      messageId: m.message_id ? String(m.message_id) : '',
      from,
      to: m.to_user_id ? String(m.to_user_id) : '',
      sessionId: m.session_id ? String(m.session_id) : '',
      groupId: m.group_id ? String(m.group_id) : '',
      contextToken: m.context_token ? String(m.context_token) : '',
      text,
      createTimeMs: Number(m.create_time_ms) || 0,
    });
  }
  return out;
}

module.exports = {
  createIlinkClient, parseLossless, extractTextMessages, encodeClientVersion,
  DEFAULT_BASE, DEFAULT_BOT_TYPE, CHANNEL_VERSION, ILINK_APP_ID, ITEM_TYPE, MSG_TYPE, LOSSLESS_ID_FIELDS,
};
