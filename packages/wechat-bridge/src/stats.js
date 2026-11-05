'use strict';
/**
 * 进程内计数器：命令吞吐 / 拒绝 / 二次确认 / 错误 / 限流。
 * 只增不减、重启清零（控制面才是持久真相，这里只为运维观察）。
 * 经 HTTP 适配器 /statsz 暴露；测试可注入 now 冻结 startedAt。
 */
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
  };

  function bump(field, n = 1) {
    s[field] = (s[field] || 0) + n;
  }

  return {
    raw: s,
    bump,
    command(cmd) {
      const k = String(cmd || '?');
      s.byCommand[k] = (s.byCommand[k] || 0) + 1;
    },
    snapshot() {
      const upMs = now() - s.startedAt;
      return { ...s, byCommand: { ...s.byCommand }, uptimeSec: Math.floor(upMs / 1000) };
    },
  };
}

module.exports = { createStats };
