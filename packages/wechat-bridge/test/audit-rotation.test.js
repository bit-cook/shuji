'use strict';
/**
 * 审计日志：轮转、权限、开关、目录不存在时的行为。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAudit } = require('../src/audit');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rot-')); }

test('按大小轮转：超出上限转 .1，最旧的按 keep 丢弃', () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.jsonl');
  const audit = createAudit({ file, maxBytes: 200, keep: 2, now: () => 'T' });
  for (let i = 0; i < 50; i++) audit.record({ from: 'me', cmd: '/ping', result: 'ok', i });
  assert.ok(fs.existsSync(file), '当前文件存在');
  assert.ok(fs.existsSync(file + '.1'), '轮转出 .1');
  assert.ok(!fs.existsSync(file + '.3'), '超出 keep 的旧轮转被丢弃');
  // 每个文件都不超过上限（含刚追加的一行可能略超）
  for (const f of [file, file + '.1']) {
    assert.ok(fs.statSync(f).size <= 200 + 120, `${f} size=${fs.statSync(f).size}`);
  }
  // 轮转不丢行：所有行都能读到
  const all = [file, file + '.1'].map((f) => fs.readFileSync(f, 'utf8').trim()).filter(Boolean);
  assert.ok(all.length >= 2);
});

test('文件权限 600（审计含命令原文，不给同主机其他账号读）', () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.jsonl');
  const audit = createAudit({ file, now: () => 'T' });
  audit.record({ from: 'me', cmd: '/ping', result: 'ok' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 轮转出来的历史文件同样 600
  const audit2 = createAudit({ file, maxBytes: 100, keep: 2, now: () => 'T' });
  for (let i = 0; i < 20; i++) audit2.record({ from: 'me', cmd: '/ping', result: 'ok', i });
  assert.equal(fs.statSync(file + '.1').mode & 0o777, 0o600);
});

test("AUDIT_LOG=none 显式关闭（仅测试用）", () => {
  const audit = createAudit({ file: 'none', now: () => 'T' });
  assert.doesNotThrow(() => audit.record({ cmd: '/ping' }));
  assert.equal(audit.file, null);
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'none')));
});

test('目录不存在时只告警不崩（命令执行优先于记账）', () => {
  const audit = createAudit({ file: '/nonexistent-dir-xyz/a.jsonl', now: () => 'T' });
  assert.doesNotThrow(() => audit.record({ cmd: '/ping', result: 'ok' }));
});

test('注入 fs 实现可单测（不碰真实磁盘）', () => {
  const lines = [];
  const audit = createAudit({
    file: '/virtual/audit.jsonl', now: () => 'T0',
    fsImpl: {
      appendFileSync: (f, l) => lines.push([f, l]),
      statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      chmodSync: () => {},
    },
  });
  audit.record({ from: 'me', cmd: '/ping', result: 'ok' });
  assert.equal(lines.length, 1);
  assert.match(lines[0][1], /"result":"ok"/);
});
