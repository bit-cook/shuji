import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askCardinal, CardinalError } from '../src/cardinal-client.ts';

interface Opts { method?: string; headers?: Record<string, string>; body?: string }
interface Call { url: string; opts: Opts }

function stubFetch(handler: (url: string, opts: Opts) => Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: unknown, opts: Opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okRes = async (data: unknown) =>
  ({ ok: true, status: 200, async text() { return JSON.stringify(data); } }) as unknown as Response;

test('POST /openclaw，带 Content-Type 与 Bearer，解析 reply', async () => {
  const { impl, calls } = stubFetch(() => okRes({ reply: 'pong · 2026-01-01T00:00:00.000Z' }));
  const reply = await askCardinal(
    { base: 'http://127.0.0.1:8080/', token: 'tk', fetchImpl: impl },
    { from: 'u1', text: '/ping' },
  );
  assert.match(reply, /^pong/);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8080/openclaw');
  assert.equal(calls[0]!.opts.method, 'POST');
  assert.equal(calls[0]!.opts.headers?.Authorization, 'Bearer tk');
  assert.equal(calls[0]!.opts.body, JSON.stringify({ from: 'u1', text: '/ping' }));
});

test('无 token 时不带 Authorization 头', async () => {
  const { impl, calls } = stubFetch(() => okRes({ reply: 'x' }));
  await askCardinal({ base: 'http://mc', fetchImpl: impl }, { from: 'u', text: '/list' });
  assert.equal(calls[0]!.opts.headers?.Authorization, undefined);
});

test('非 2xx 抛 CardinalError 并带 status', async () => {
  const { impl } = stubFetch(async () => ({ ok: false, status: 502, async text() { return 'bad gateway'; } }) as unknown as Response);
  await assert.rejects(
    () => askCardinal({ base: 'http://mc', fetchImpl: impl }, { from: 'u', text: '/list' }),
    (e) => e instanceof CardinalError && e.status === 502 && /502/.test(e.message),
  );
});

test('响应缺 reply 字段抛错', async () => {
  const { impl } = stubFetch(() => okRes({ error: 'nope' }));
  await assert.rejects(
    () => askCardinal({ base: 'http://mc', fetchImpl: impl }, { from: 'u', text: '/list' }),
    (e) => e instanceof CardinalError && /reply/.test(e.message),
  );
});

test('AbortError 转为超时错误', async () => {
  const { impl } = stubFetch(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  await assert.rejects(
    () => askCardinal({ base: 'http://mc', fetchImpl: impl }, { from: 'u', text: '/list' }),
    (e) => e instanceof CardinalError && /超时/.test(e.message),
  );
});

test('缺 cardinalBase 直接抛错', async () => {
  await assert.rejects(
    () => askCardinal({ base: '', fetchImpl: (async () => okRes({ reply: 'x' })) as unknown as typeof fetch }, { from: 'u', text: '/ping' }),
    (e) => e instanceof CardinalError && /cardinalBase/.test(e.message),
  );
});
