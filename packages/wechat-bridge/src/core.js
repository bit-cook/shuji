'use strict';
/**
 * 命令路由核心：平台无关。输入 (text, fromUser)，输出回复字符串。
 * 红线落地：allowFrom 白名单 / 危险命令二次确认 / 全量审计。
 */
const { createConfirmStore, DANGEROUS_COMMANDS } = require('./confirm');

const USAGE = [
  '支持命令：',
  '/ping — 链路自检',
  '/list — 全部 Agent 状态',
  '/status <id> — 单个 Agent 详情',
  '/tasks <id> — 最近任务',
  '/cost — Token 成本汇总',
  '/dispatch <id> <任务> — 下发任务（需二次确认）',
].join('\n');

// 微信文本消息上限 2048 字节，留余量
const MAX_REPLY = 1500;

function clip(s) {
  s = String(s);
  return s.length > MAX_REPLY ? s.slice(0, MAX_REPLY) + '\n…（已截断）' : s;
}

function agentLine(a) {
  const id = a.agentId || a.id || '?';
  const status = a.status || '?';
  const model = a.model ? ' ' + a.model : '';
  return `${id} [${status}]${model}`;
}

function createRouter({
  mc,
  allowFrom = [],
  audit,
  now = () => Date.now(),
  isoNow = () => new Date().toISOString(),
  confirmStore,
} = {}) {
  if (!mc) throw new Error('createRouter 需要 mc 客户端');
  const allow = new Set((allowFrom || []).filter(Boolean));
  const confirm = confirmStore || createConfirmStore({ now });
  const logger = audit || { record() {} };

  async function runCommand(cmd, parts, fromUser) {
    switch (cmd) {
      case '/ping':
        return 'pong · ' + isoNow();
      case '/help':
        return USAGE;
      case '/list': {
        const data = await mc.get('/api/agents');
        const agents = Array.isArray(data) ? data : (data.data || []);
        if (agents.length === 0) return '暂无已注册 Agent';
        return clip(agents.map(agentLine).join('\n'));
      }
      case '/status': {
        const id = parts[1];
        if (!id) return '用法：/status <agentId>';
        return clip(JSON.stringify(await mc.get('/api/agents/' + encodeURIComponent(id)), null, 2));
      }
      case '/tasks': {
        const id = parts[1];
        if (!id) return '用法：/tasks <agentId>';
        return clip(JSON.stringify(await mc.get('/api/agents/' + encodeURIComponent(id) + '/tasks'), null, 2));
      }
      case '/cost':
        return clip(JSON.stringify(await mc.get('/api/costs/summary'), null, 2));
      case '/dispatch': {
        const id = parts[1];
        const title = parts.slice(2).join(' ');
        if (!id || !title) return '用法：/dispatch <agentId> <任务内容>';
        const task = { agentId: id, title, createdAt: now() };
        const r = await mc.post('/api/tasks', task);
        return '已下发：' + JSON.stringify(r);
      }
      default:
        return '未知命令。' + USAGE;
    }
  }

  async function handle(text, fromUser) {
    const cmdText = String(text == null ? '' : text).trim().slice(0, 500);
    const entry = { from: fromUser, cmd: cmdText };

    if (!allow.has(fromUser)) {
      entry.result = 'denied';
      logger.record(entry);
      return '拒绝访问：不在白名单内';
    }

    const parts = cmdText.split(/\s+/);
    const cmd = parts[0];

    try {
      // /confirm <token>：消费确认令牌，执行原危险命令
      if (cmd === '/confirm') {
        const r = confirm.consume(parts[1], fromUser);
        if (!r.ok) {
          entry.result = 'confirm_failed';
          entry.reason = r.reason;
          logger.record(entry);
          return '确认失败：' + r.reason;
        }
        const orig = r.command.split(/\s+/);
        entry.confirmed = r.command;
        const reply = await runCommand(orig[0], orig, fromUser);
        entry.result = 'ok';
        logger.record(entry);
        return reply;
      }

      // 危险命令：先发令牌，二次确认后才执行
      if (DANGEROUS_COMMANDS.has(cmd)) {
        const token = confirm.create({ fromUser, text: cmdText });
        entry.result = 'confirm_required';
        logger.record(entry);
        return [
          '⚠ 危险操作待确认：' + cmdText,
          `60 秒内发送 /confirm ${token} 执行`,
          '发送其他任意消息即取消',
        ].join('\n');
      }

      const reply = await runCommand(cmd, parts, fromUser);
      entry.result = 'ok';
      logger.record(entry);
      return reply;
    } catch (e) {
      entry.result = 'error';
      entry.error = String((e && e.message) || e);
      logger.record(entry);
      return '处理失败：' + entry.error;
    }
  }

  return { handle, confirm, USAGE };
}

module.exports = { createRouter, USAGE, DANGEROUS_COMMANDS };
