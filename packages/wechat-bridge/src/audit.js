'use strict';
/**
 * 审计日志：JSONL 追加写。每一条命令（含被拒绝的）都留痕。
 * 不配置 file 时退化为静默（测试可用）。
 */
const fs = require('node:fs');

function createAudit({ file, fsImpl, now = () => new Date().toISOString() } = {}) {
  const fsx = fsImpl || fs;
  return {
    record(entry) {
      const line = JSON.stringify({ ts: now(), ...entry });
      if (!file) return;
      try {
        fsx.appendFileSync(file, line + '\n');
      } catch (e) {
        process.stderr.write('audit write failed: ' + e.message + '\n');
      }
    },
  };
}

module.exports = { createAudit };
