'use strict';
/**
 * 进程内计数器：命令吞吐 / 拒绝 / 二次确认 / 错误 / 限流。
 * 只增不减、重启清零（控制面才是持久真相，这里只为运维观察）。
 * 经 HTTP 适配器 /statsz 暴露；测试可注入 now 冻结 startedAt。
 *
 * byCommand 的键取自消息的第一个词——**包含陌生人的消息**（白名单校验在计数之后）。
 * 不设上限的话，往 /message 灌垃圾文本就能把这张 Map 撑到无界，而 /statsz 是
 * 免鉴权的，注入的字符串还会被读回去。所以对键数设硬上限，超出归并到一个聚合桶。
 */
const MAX_COMMAND_KEYS = 64;

function createStats({ now = () => Date.now() } = {}) {
  const s = {
    startedAt: now(),
    commands: 0,       // 进入命令核心的总消息数（含被拒）
    allowed: 0,        // 白名单内、真正执行的
    denied: 0,         // 白名单外拒绝
    confirmRequired: 0,
    confirmFailed: 0,
    confirmOk: 0,
    errors: 0,
    rateLimited: 0,
    byCommand: {},     // { '/list': 3, ... }
    commandKeysDropped: 0, // 因超出键上限被归并的词条数
  };

  function bump(field, n = 1) {
    s[field] = (s[field] || 0) + n;
  }

  return {
    raw: s,
    bump,
    command(cmd) {
      const k = String(cmd || '?').slice(0, 64); // 单个键也截断，避免超长词条
      if (Object.prototype.hasOwnProperty.call(s.byCommand, k)) {
        s.byCommand[k] += 1;
        return;
      }
      // 给聚合桶预留一个名额，否则第一次归并时键数会冲到上限+1
      const hasOther = Object.prototype.hasOwnProperty.call(s.byCommand, '*other');
      const room = Math.max(0, MAX_COMMAND_KEYS - (hasOther ? 1 : 2));
      if (Object.keys(s.byCommand).length <= room) {
        s.byCommand[k] = 1;
        return;
      }
      s.commandKeysDropped = (s.commandKeysDropped || 0) + 1;
      s.byCommand['*other'] = (s.byCommand['*other'] || 0) + 1;
    },
    snapshot() {
      const upMs = now() - s.startedAt;
      return { ...s, byCommand: { ...s.byCommand }, uptimeSec: Math.floor(upMs / 1000) };
    },
  };
}

module.exports = { createStats, MAX_COMMAND_KEYS };
