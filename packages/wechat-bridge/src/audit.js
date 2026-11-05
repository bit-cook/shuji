'use strict';
/**
 * 审计日志：JSONL 追加写。每一条命令（含被拒绝的）都留痕。
 * 红线配套：
 *   - 文件权限 600（审计含命令原文与用户 ID，不给同主机其他账号读）
 *   - 可按大小轮转（默认 10MB × 保留 3 份），避免长期运行写满磁盘
 *   - 写失败只告警不阻断（命令执行优先于记账）
 * file 传 'none' 或留空表示关闭（仅测试用）。
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 3;

function createAudit({
  file,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  mode = 0o600,
  fsImpl,
  now = () => new Date().toISOString(),
} = {}) {
  const fsx = fsImpl || fs;
  const enabled = !!file && file !== 'none';
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
  const keepN = Math.max(1, Number(keep) || 1);

  function rotate() {
    if (!limit) return;
    let size = 0;
    try { size = fsx.statSync(file).size; } catch { return; }
    if (size < limit) return;
    // file.(keepN-1) → file.keepN 方向上一位覆盖；最旧的直接丢弃
    for (let i = keepN - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      try {
        if (i === keepN - 1) fsx.rmSync(from, { force: true });
        else fsx.renameSync(from, to);
      } catch { /* 单份轮转失败不阻断 */ }
    }
    try {
      fsx.renameSync(file, file + '.1');
    } catch { /* 忽略 */ }
  }

  return {
    record(entry) {
      if (!enabled) return;
      const line = JSON.stringify({ ts: now(), ...entry });
      try {
        rotate();
        // mode 交给 appendFileSync：只在新文件创建时生效，正好覆盖「文件被外部
        // 删掉后重建」这条路径。用 ensured 闩锁的话，重建文件会沿用进程 umask
        // （通常 0644），审计里的用户 ID 与命令原文就谁都能读了。
        fsx.appendFileSync(file, line + '\n', { mode });
      } catch (e) {
        process.stderr.write('audit write failed: ' + e.message + '\n');
      }
    },
    get file() { return enabled ? file : null; },
  };
}

module.exports = { createAudit, DEFAULT_MAX_BYTES, DEFAULT_KEEP };
