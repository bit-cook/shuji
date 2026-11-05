'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseConfig, guardPublicBind, isPublicHost, ConfigError, DEFAULTS, num, bool,
} = require('../src/config');

const GOOD = { MC_API_KEY: 'a'.repeat(32) };

describe('parseConfig 默认值', () => {
  test('只给 MC_API_KEY 时其余取默认', () => {
    const { config, errors, warnings } = parseConfig(GOOD, { cwd: '/tmp' });
    assert.deepEqual(errors, []);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3000);
    assert.equal(config.dbPath, path.resolve('/tmp', 'mission-control.db'));
    assert.equal(config.auditFile, 'audit.jsonl');
    assert.equal(config.auditMaxBytes, 10 * 1024 * 1024);
    assert.equal(config.auditKeep, 3);
    assert.equal(config.staleSec, 900);
    assert.equal(config.tasksPerAgent, 500);
    assert.equal(config.rateLimitPerMin, 600);
    assert.equal(config.rateLimitBurst, 200);
    assert.equal(config.maxBodyBytes, 1024 * 1024);
    assert.equal(config.logLevel, 'info');
    assert.deepEqual(warnings, []);
  });

  test('绝对路径的 MC_DB 原样保留', () => {
    const { config } = parseConfig({ ...GOOD, MC_DB: '/var/lib/cardinal/mc.db' });
    assert.equal(config.dbPath, '/var/lib/cardinal/mc.db');
  });

  test('相对路径按 cwd 解析', () => {
    const { config } = parseConfig({ ...GOOD, MC_DB: 'data/mc.db' }, { cwd: '/srv' });
    assert.equal(config.dbPath, '/srv/data/mc.db');
  });
});

describe('parseConfig 红线', () => {
  test('缺 MC_API_KEY 报错（控制面无鉴权即全局可下令）', () => {
    const { errors } = parseConfig({});
    assert.ok(errors.some((e) => e.includes('MC_API_KEY')));
  });

  test('空串 MC_API_KEY 同样报错', () => {
    const { errors } = parseConfig({ MC_API_KEY: '   ' });
    assert.ok(errors.some((e) => e.includes('MC_API_KEY')));
  });

  test('默认拒绑 0.0.0.0', () => {
    const { errors } = parseConfig({ ...GOOD, MC_HOST: '0.0.0.0' });
    assert.ok(errors.some((e) => e.includes('不得暴露公网')));
  });

  test('空 host 按 127.0.0.1 处理并告警，不当成通配', () => {
    const { config, errors, warnings } = parseConfig({ ...GOOD, MC_HOST: '' });
    assert.deepEqual(errors, []);
    assert.equal(config.host, '127.0.0.1');
    assert.ok(warnings.some((w) => w.includes('MC_HOST 为空')));
  });

  test('ALLOW_PUBLIC_BIND=1 显式放行', () => {
    const { errors, warnings } = parseConfig({ ...GOOD, MC_HOST: '0.0.0.0', ALLOW_PUBLIC_BIND: '1' });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  test('Tailscale 地址与回环都允许', () => {
    for (const h of ['127.0.0.1', 'localhost', '100.64.0.1', 'fd7a:115c:a1e0::1']) {
      assert.deepEqual(parseConfig({ ...GOOD, MC_HOST: h }).errors, [], h);
    }
  });
});

describe('parseConfig 数值校验', () => {
  test('拼错数字报错，不静默回落默认值', () => {
    for (const [k, v] of [
      ['MC_PORT', 'abc'], ['MC_STALE_SEC', 'soon'], ['MC_TASKS_PER_AGENT', 'many'],
      ['MC_AUDIT_KEEP', 'few'], ['MC_RATE_LIMIT_PER_MIN', 'lots'], ['MC_MAX_BODY_BYTES', 'big'],
    ]) {
      assert.ok(parseConfig({ ...GOOD, [k]: v }).errors.some((e) => e.includes(k)), k);
    }
  });

  test('端口越界报错', () => {
    assert.ok(parseConfig({ ...GOOD, MC_PORT: '0' }).errors.some((e) => e.includes('MC_PORT')));
    assert.ok(parseConfig({ ...GOOD, MC_PORT: '70000' }).errors.some((e) => e.includes('MC_PORT')));
  });

  test('限流与上限不能为负', () => {
    assert.ok(parseConfig({ ...GOOD, MC_RATE_LIMIT_PER_MIN: '-1' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_RATE_LIMIT_BURST: '0' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_AUDIT_KEEP: '0' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_AUDIT_MAX_BYTES: '-1' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_STALE_SEC: '-1' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_TASKS_PER_AGENT: '-1' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_MAX_BODY_BYTES: '512' }).errors.length > 0);
    assert.ok(parseConfig({ ...GOOD, MC_MAX_TASK_TITLE: '8' }).errors.length > 0);
  });

  test('限流配 0 = 关闭（合法）', () => {
    assert.deepEqual(parseConfig({ ...GOOD, MC_RATE_LIMIT_PER_MIN: '0' }).errors, []);
  });

  test('空字符串环境变量按缺省处理，不当成 0', () => {
    const { config } = parseConfig({ ...GOOD, MC_PORT: '', MC_STALE_SEC: '' });
    assert.equal(config.port, DEFAULTS.port);
    assert.equal(config.staleSec, DEFAULTS.staleSec);
  });
});

describe('parseConfig 告警', () => {
  test('短 API Key 给告警但不阻断', () => {
    const { errors, warnings } = parseConfig({ MC_API_KEY: 'short' });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes('16 字符')));
  });

  test('关审计给告警', () => {
    const { warnings } = parseConfig({ ...GOOD, MC_AUDIT_LOG: 'none' });
    assert.ok(warnings.some((w) => w.includes('审计已关闭')));
  });

  test('LOG_LEVEL 被接纳且小写归一', () => {
    assert.equal(parseConfig({ ...GOOD, LOG_LEVEL: 'DEBUG' }).config.logLevel, 'debug');
    assert.equal(parseConfig({ ...GOOD, MC_LOG_LEVEL: 'warn' }).config.logLevel, 'warn');
  });
});

describe('guardPublicBind', () => {
  test('通配地址默认抛错，且是 ConfigError', () => {
    assert.throws(() => guardPublicBind('0.0.0.0', {}), ConfigError);
    assert.throws(() => guardPublicBind('::', {}), /红线/);
    assert.throws(() => guardPublicBind('', {}), /红线/);
  });

  test('ALLOW_PUBLIC_BIND=1 放行', () => {
    assert.doesNotThrow(() => guardPublicBind('0.0.0.0', { ALLOW_PUBLIC_BIND: '1' }));
  });

  test('回环与具体地址直接放行', () => {
    for (const h of ['127.0.0.1', '100.64.0.1', 'localhost']) {
      assert.doesNotThrow(() => guardPublicBind(h, {}));
    }
  });

  test('isPublicHost 识别通配写法', () => {
    for (const h of ['0.0.0.0', '::', '[::]', '', '*', '::0']) assert.equal(isPublicHost(h), true, h);
    for (const h of ['127.0.0.1', '100.64.0.1', 'localhost', '0.0.0.1']) {
      assert.equal(isPublicHost(h), false, h);
    }
  });
});

describe('标量解析助手', () => {
  test('num 容错', () => {
    assert.equal(num(undefined, 7), 7);
    assert.equal(num('', 7), 7);
    assert.equal(num('  ', 7), 7);
    assert.equal(num('0', 7), 0);
    assert.equal(num('12.7', 7), 12.7);
    assert.equal(num('abc', 7), 7);
  });

  test('bool 只认 1/true', () => {
    assert.equal(bool('1'), true);
    assert.equal(bool('true'), true);
    assert.equal(bool('TRUE'), true);
    assert.equal(bool('0'), false);
    assert.equal(bool('yes'), false);
    assert.equal(bool(undefined), false);
  });
});
