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

test('行首才算命令：对话里提到命令不劫持消息', () => {
  assert.equal(extractCommand('看看 /list 怎么用'), null);
  assert.equal(extractCommand('这个 /status 命令是干嘛的'), null);
  assert.equal(extractCommand('帮我 /dispatch 一个任务好不好'), null);
  assert.equal(extractCommand('第一行是废话\n第二行也是\n/ping'), '/ping');
});

test('同行前缀形态：前缀 + 冒号 + 命令', () => {
  assert.equal(extractCommand('[微信 · DM] user123: /list'), '/list');
  assert.equal(extractCommand('Telegram 42: /status node-a'), '/status node-a');
  // 冒号后不是命令 → 不命中
  assert.equal(extractCommand('备注: 看看 /list'), null);
  // 前缀过长 → 视为普通文本
  const longPrefix = 'x'.repeat(80);
  assert.equal(extractCommand(`${longPrefix}: /list`), null);
});

test('命令词边界：/listx /usr/list 不算', () => {
  assert.equal(extractCommand('/listx'), null);
  assert.equal(extractCommand('/usr/list'), null);
  assert.equal(extractCommand('/dispatchx node-a x'), null);
});

test('前导空白与全角斜杠', () => {
  assert.equal(extractCommand('   /ping'), '/ping');
  assert.equal(extractCommand('\t/cost'), '/cost');
});

test('多行只取第一个命令所在行', () => {
  assert.equal(extractCommand('/ping\n/list'), '/ping');
  assert.equal(extractCommand('废话\n  /status node-a  \n尾巴'), '/status node-a');
});
