import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommand, isCardinalCommandWord, CARDINAL_COMMANDS } from '../src/commands.ts';

test('裸命令直接命中', () => {
  assert.equal(extractCommand('/ping'), '/ping');
  assert.equal(extractCommand('/list'), '/list');
  assert.equal(extractCommand('/status node-a'), '/status node-a');
  assert.equal(extractCommand('/dispatch node-a 夜间巡检'), '/dispatch node-a 夜间巡检');
  assert.equal(extractCommand('/confirm A1B2C3D4'), '/confirm A1B2C3D4');
});

test('带通道上下文前缀的 prepared prompt 也能提取', () => {
  const body = '[微信 · DM] user123:\n/list';
  assert.equal(extractCommand(body), '/list');
});

test('普通对话不命中', () => {
  assert.equal(extractCommand('帮我看一下今天的安排'), null);
  assert.equal(extractCommand(''), null);
  assert.equal(extractCommand('列表 /listx 不行'), null);
  assert.equal(extractCommand('路径是 /usr/list 目录'), null);
});

test('只取命令所在行', () => {
  const body = '/status node-a\n另外再说一句别的';
  assert.equal(extractCommand(body), '/status node-a');
});

test('命令词表自洽', () => {
  for (const c of CARDINAL_COMMANDS) {
    assert.ok(isCardinalCommandWord(c), c);
  }
  assert.ok(!isCardinalCommandWord('/nope'));
});
