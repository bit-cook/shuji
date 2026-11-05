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

/**
 * 0600 权限只在 POSIX 文件系统上可验证：Windows/NTFS 不表示 POSIX 位，
 * Node 写入时给 0600 读回来的也是 0666。部署目标是 Linux（systemd/Docker），
 * Windows 开发机上跳过位级断言，其余行为照常验证。
 */
const POSIX_MODE_CHECKABLE = process.platform !== 'win32';

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
  if (POSIX_MODE_CHECKABLE) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 轮转出来的历史文件同样 600
  const audit2 = createAudit({ file, maxBytes: 100, keep: 2, now: () => 'T' });
  for (let i = 0; i < 20; i++) audit2.record({ from: 'me', cmd: '/ping', result: 'ok', i });
  if (POSIX_MODE_CHECKABLE) assert.equal(fs.statSync(file + '.1').mode & 0o777, 0o600);
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

// ---- 审计文件的权限：被外部删掉后重建，不能沿用进程 umask ----
test('审计：文件被外部删除后重建，仍是 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-audit-'));
  const file = path.join(dir, 'a.jsonl');
  const a = createAudit({ file });
  a.record({ from: 'me', cmd: '/ping' });
  if (POSIX_MODE_CHECKABLE) assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // 模拟外部清理（logrotate 之外的任何 rm）：进程不知道文件没了
  fs.rmSync(file);
  a.record({ from: 'me', cmd: '/ping' });

  if (POSIX_MODE_CHECKABLE) {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600,
      `重建的审计文件权限应为 0600，实际 ${mode.toString(8)}——审计含用户 ID 与命令原文`);
  } else {
    // Windows 上这条路径的可验部分：重建后文件存在且继续可写
    assert.ok(fs.existsSync(file));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审计：轮转出来的 .1 文件也是 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardinal-audit-'));
  const file = path.join(dir, 'b.jsonl');
  const a = createAudit({ file, maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i++) a.record({ from: 'me', cmd: '/ping', n: i });
  const rotated = `${file}.1`;
  assert.ok(fs.existsSync(rotated), '应发生轮转');
  if (POSIX_MODE_CHECKABLE) assert.equal(fs.statSync(rotated).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
