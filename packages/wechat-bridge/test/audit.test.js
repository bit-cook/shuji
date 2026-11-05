'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAudit } = require('../src/audit');

test('审计写 JSONL，一条一行', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'a.jsonl');
  const audit = createAudit({ file, now: () => 'T0' });
  audit.record({ from: 'me', cmd: '/ping', result: 'ok' });
  audit.record({ from: 'x', cmd: '/list', result: 'denied' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.ts, 'T0');
  assert.equal(first.result, 'ok');
});

test('写失败不影响主流程', () => {
  const audit = createAudit({ file: '/proc/definitely/not/writable', now: () => 'T0' });
  assert.doesNotThrow(() => audit.record({ cmd: '/ping', result: 'ok' }));
});

test('未配置文件时静默', () => {
  const audit = createAudit({ now: () => 'T0' });
  assert.doesNotThrow(() => audit.record({ cmd: '/ping' }));
});
