'use strict';
/**
 * 命令路由核心：平台无关。输入 (text, fromUser)，输出回复字符串。
 * 红线落地：allowFrom 白名单 / 危险命令二次确认 / 全量审计 / 限流。
 */
const { createConfirmStore, DANGEROUS_COMMANDS } = require('./confirm');
const { createRateLimiter } = require('./ratelimit');
const { createStats } = require('./stats');
const { createNoopLogger } = require('./log');

const USAGE = [
  '支持命令：',
  '/ping — 链路自检',
  '/list — 全部 Agent 状态',
  '/status <id> — 单个 Agent 详情',
  '/tasks <id> — 最近任务',
  '/cost — Token 成本汇总',
  '/dispatch <id> <任务> — 下发任务（需二次确认）',
  '/confirm <令牌> — 确认执行待确认的危险命令',
  '/help — 显示本帮助',
].join('\n');

// 微信文本消息上限 2048 字节，中文 1 字 3 字节，按 UTF-8 字节数截断更稳
const MAX_REPLY_BYTES = 1500;
// 命令原文上限：再长只可能是粘贴内容，截断后按未知命令处理
const MAX_CMD_CHARS = 500;

function clip(s) {
  s = String(s);
  if (Buffer.byteLength(s, 'utf8') <= MAX_REPLY_BYTES) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > MAX_REPLY_BYTES) break;
    out += ch;
    bytes += b;
  }
  return out + '\n…（已截断）';
}

/**
 * 输入归一化：中文输入法全角斜杠、零宽字符、连续空白。
 * 微信里手打「／ping」是常态，不该因此吃到「未知命令」。
 */
function normalize(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/／/g, '/');            // ／ → /
  s = s.replace(/[​-‍﻿]/g, ''); // 零宽字符 / BOM
  s = s.replace(/\s+/g, ' ');                // 连续空白（含换行）→ 单空格
  return s.trim();
}

function agentLine(a) {
  const id = a.agentId || a.id || '?';
  const status = a.status || '?';
  const model = a.model ? ' ' + a.model : '';
  return `${id} [${status}]${model}`;
}

/** 管理面可能返回数组、{data:[…]} 或 {agents:[…]}，统一成数组。 */
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.agents)) return data.agents;
  return [];
}

function createRouter({
  mc,
  allowFrom = [],
  audit,
  now = () => Date.now(),
  isoNow = () => new Date().toISOString(),
  confirmStore,
  rateLimiter,
  stats,
  logger = createNoopLogger(),
} = {}) {
  if (!mc) throw new Error('createRouter 需要 mc 客户端');
  const allow = new Set((allowFrom || []).filter(Boolean).map(String));
  const confirm = confirmStore || createConfirmStore({ now });
  const recorder = audit || { record() {} };
  const limiter = rateLimiter || createRateLimiter({ perMinute: 0 }); // 默认不限流（调用方按需开启）
  const counter = stats || createStats({ now });
  const log = logger.child ? logger.child({ mod: 'core' }) : createNoopLogger();

  async function getAgent(id) {
    try {
      return await mc.get('/api/agents/' + encodeURIComponent(id));
    } catch (e) {
      if (e && e.status === 404) {
        const err = new Error('未找到 Agent：' + id);
        err.status = 404;
        throw err;
      }
      throw e;
    }
  }

  async function runCommand(cmd, parts, fromUser) {
    switch (cmd) {
      case '/ping':
        return 'pong · ' + isoNow();
      case '/help':
        return USAGE;
      case '/list': {
        const data = await mc.get('/api/agents');
        const agents = toArray(data);
        if (agents.length === 0) return '暂无已注册 Agent';
        return clip(agents.map(agentLine).join('\n'));
      }
      case '/status': {
        const id = parts[1];
        if (!id) return '用法：/status <agentId>';
        return clip(JSON.stringify(await getAgent(id), null, 2));
      }
      case '/tasks': {
        const id = parts[1];
        if (!id) return '用法：/tasks <agentId>';
        try {
          return clip(JSON.stringify(await mc.get('/api/agents/' + encodeURIComponent(id) + '/tasks'), null, 2));
        } catch (e) {
          if (e && e.status === 404) return '未找到 Agent：' + id;
          throw e;
        }
      }
      case '/cost':
        return clip(JSON.stringify(await mc.get('/api/costs/summary'), null, 2));
      case '/dispatch': {
        const id = parts[1];
        const title = parts.slice(2).join(' ');
        if (!id || !title) return '用法：/dispatch <agentId> <任务内容>';
        const task = { agentId: id, title, createdAt: now() };
        let r;
        try {
          r = await mc.post('/api/tasks', task);
        } catch (e) {
          // 控制面会对未注册 Agent 回 404：这是打字错误，不该显示成「管理面返回 404」
          if (e && e.status === 404) {
            const err = new Error('未找到 Agent：' + id);
            err.status = 404;
            throw err;
          }
          throw e;
        }
        const lines = ['已下发：' + JSON.stringify(r)];
        if (r && r.titleTruncated) {
          lines.push('（任务内容超长，控制面已按上限截断）');
        }
        return lines.join('\n');
      }
      default:
        return '未知命令。' + USAGE;
    }
  }

  async function handle(text, fromUser, meta = {}) {
    const user = String(fromUser == null ? '' : fromUser);
    const cmdText = normalize(text).slice(0, MAX_CMD_CHARS);
    const entry = { from: user, cmd: cmdText };
    if (meta.channel) entry.channel = meta.channel;
    counter.bump('commands');
    counter.command(cmdText.split(' ')[0] || '?');

    // 限流（防重试风暴；被限流也留痕）
    const gate = limiter.check(user);
    if (!gate.ok) {
      entry.result = 'rate_limited';
      entry.retryAfterMs = gate.retryAfterMs;
      recorder.record(entry);
      counter.bump('rateLimited');
      log.warn('rate limited', { from: user, retryAfterMs: gate.retryAfterMs });
      return '请求过于频繁，请 ' + Math.ceil((gate.retryAfterMs || 1000) / 1000) + ' 秒后再试';
    }

    if (!allow.has(user)) {
      entry.result = 'denied';
      recorder.record(entry);
      counter.bump('denied');
      return '拒绝访问：不在白名单内';
    }

    const parts = cmdText.split(' ');
    const cmd = parts[0];
    counter.bump('allowed');

    try {
      // /confirm <token>：消费确认令牌，执行原危险命令
      if (cmd === '/confirm') {
        const r = confirm.consume(parts[1], user);
        if (!r.ok) {
          entry.result = 'confirm_failed';
          entry.reason = r.reason;
          recorder.record(entry);
          counter.bump('confirmFailed');
          return '确认失败：' + r.reason;
        }
        const orig = r.command.split(' ');
        entry.confirmed = r.command;
        const reply = await runCommand(orig[0], orig, user);
        entry.result = 'ok';
        recorder.record(entry);
        counter.bump('confirmOk');
        return reply;
      }

      // 危险命令：先发令牌，二次确认后才执行
      if (DANGEROUS_COMMANDS.has(cmd)) {
        const token = confirm.create({ fromUser: user, text: cmdText });
        entry.result = 'confirm_required';
        recorder.record(entry);
        counter.bump('confirmRequired');
        return [
          '⚠ 危险操作待确认：' + cmdText,
          `60 秒内发送 /confirm ${token} 执行`,
          '发送其他任意消息即取消',
        ].join('\n');
      }

      const reply = await runCommand(cmd, parts, user);
      entry.result = 'ok';
      recorder.record(entry);
      return reply;
    } catch (e) {
      entry.result = 'error';
      entry.error = String((e && e.message) || e);
      recorder.record(entry);
      counter.bump('errors');
      log.error('command failed', { from: user, cmd, error: entry.error });
      return '处理失败：' + entry.error;
    }
  }

  return { handle, confirm, USAGE, stats: counter };
}

module.exports = { createRouter, USAGE, DANGEROUS_COMMANDS, normalize, clip, toArray };
