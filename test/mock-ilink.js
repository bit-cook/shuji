'use strict';
/**
 * iLink 协议测试桩：get_bot_qrcode / get_qrcode_status / getupdates / sendmessage。
 * 仅供本地验收（单测/e2e），不是产品代码。
 *
 * 与 mock-telegram 的区别：getupdates 是「客户端超时属正常」的长轮询，且带
 * get_updates_buf 同步游标。桩把这两点都按真实行为模拟：
 *   - 无消息时挂起请求直到有新消息或 150ms 后返回空
 *   - get_updates_buf 由桩推进，原样回传给被测代码，借以验证它没有丢游标
 */
const http = require('node:http');

function createMockIlink({
  failFirstGetUpdates = false,
  statusScript = ['confirmed'],
} = {}) {
  const state = {
    msgs: [],
    sent: [],
    calls: [],
    getUpdatesCalls: 0,
    buf: 'buf-0',
    nextBuf: 0,
    failed: false,
    lastHeaders: null,
    lastGetUpdatesBody: null,
    statusIndex: 0,
  };
  const waiters = [];

  function flush() {
    while (waiters.length > 0 && state.msgs.length > 0) {
      waiters.shift()();
    }
  }

  /** 推一条「用户发来的文本消息」。item_list 用真实的 iLink 形状。 */
  function pushUserText({ from, text, messageId = 'm' + (state.msgs.length + 1), groupId = '', contextToken = '' }) {
    state.msgs.push({
      seq: state.msgs.length + 1,
      message_id: messageId,
      from_user_id: from,
      to_user_id: 'bot-self',
      client_id: 'c1',
      create_time_ms: 1700000000000,
      update_time_ms: 1700000000000,
      session_id: 's1',
      group_id: groupId,
      message_type: 1,
      message_state: 2,
      item_list: [{ type: 1, msg_id: 'i' + state.msgs.length, text_item: { text } }],
      context_token: contextToken,
      run_id: 'r1',
    });
    flush();
  }

  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const parsed = body ? JSON.parse(body) : {};
      state.calls.push({ method: url.pathname, query: url.search, body: parsed });
      state.lastHeaders = req.headers;
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname.endsWith('/get_bot_qrcode')) {
        json(200, { qrcode: 'wxqr://abc', qrcode_img_content: 'https://weixin.qq.com/qr/abc' });
        return;
      }
      if (url.pathname.endsWith('/get_qrcode_status')) {
        const status = statusScript[Math.min(state.statusIndex, statusScript.length - 1)];
        state.statusIndex++;
        if (status === 'confirmed') {
          json(200, {
            status, bot_token: 'tok-xyz', ilink_bot_id: 'bot-123',
            baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'wx-user-42',
          });
        } else if (status === 'scaned_but_redirect') {
          json(200, { status, redirect_host: 'ilinkai-redirect.weixin.qq.com' });
        } else if (status === 'binded_redirect') {
          json(200, { status });
        } else if (status === 'need_verifycode') {
          json(200, { status });
        } else {
          json(200, { status: status || 'wait' });
        }
        return;
      }
      if (url.pathname.endsWith('/getupdates')) {
        state.getUpdatesCalls++;
        state.lastGetUpdatesBody = parsed;
        if (failFirstGetUpdates && !state.failed) {
          state.failed = true;
          json(500, { ret: -1, errmsg: 'injected failure' });
          return;
        }
        const ready = state.msgs;
        if (ready.length > 0) {
          state.nextBuf++;
          state.buf = 'buf-' + state.nextBuf;
          json(200, { ret: 0, errcode: 0, msgs: ready, get_updates_buf: state.buf, longpolling_timeout_ms: 35000 });
          state.msgs = [];
          return;
        }
        // 模拟长轮询：等新消息，或最多 EMPTY_AFTER_MS 后返回空。
        // 这个延迟必须**明显短于**被测代码的 pollTimeoutMs：两边一样长时，
        // 客户端超时与服务端应答互相赛跑，客户端会 abort 一个服务端刚收到
        // 一半的请求——桩于是记下一个不完整的请求体，断言看起来就像
        // 「游标没回传」。真实服务端是握住请求不放的那一方，桩也该这样。
        const EMPTY_AFTER_MS = 150;
        const waiter = () => {
          clearTimeout(timer);
          state.nextBuf++;
          state.buf = 'buf-' + state.nextBuf;
          json(200, { ret: 0, msgs: state.msgs.splice(0), get_updates_buf: state.buf, longpolling_timeout_ms: 35000 });
        };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          json(200, { ret: 0, msgs: [], get_updates_buf: state.buf, longpolling_timeout_ms: 35000 });
        }, EMPTY_AFTER_MS);
        return;
      }
      if (url.pathname.endsWith('/sendmessage')) {
        state.sent.push(parsed.msg);
        json(200, { ret: 0, message_id: 'sent-' + state.sent.length, errmsg: 'ok' });
        return;
      }
      json(404, { ret: 404, errmsg: 'unknown endpoint: ' + url.pathname });
    });
  };

  const server = http.createServer(handler);
  return {
    state,
    pushUserText,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createMockIlink };
