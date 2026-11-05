/**
 * 枢机控制面 HTTP 客户端（纯函数式，零依赖，可单测）。
 * POST {base}/openclaw  {"from": "<senderId>", "text": "<命令>"}  -> {"reply": "..."}
 */

export interface AskCardinalOptions {
  base: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AskCardinalPayload {
  from: string;
  text: string;
}

export class CardinalError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CardinalError';
    this.status = status;
  }
}

export async function askCardinal(
  opts: AskCardinalOptions,
  payload: AskCardinalPayload,
): Promise<string> {
  if (!opts || !opts.base) throw new CardinalError('cardinalBase 未配置');
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new CardinalError('无可用 fetch');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 10000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
    const res = await doFetch(opts.base.replace(/\/+$/, '') + '/openclaw', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 原样处理 */
    }
    if (!res.ok) {
      throw new CardinalError(`枢机返回 ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    const reply = (data as { reply?: unknown })?.reply;
    if (typeof reply !== 'string') throw new CardinalError('枢机响应缺少 reply 字段');
    return reply;
  } catch (e: unknown) {
    if (e instanceof CardinalError) throw e;
    const name = (e as { name?: string } | null)?.name;
    if (name === 'AbortError') throw new CardinalError('枢机响应超时');
    const message = (e as { message?: string } | null)?.message;
    throw new CardinalError(String(message || e));
  } finally {
    clearTimeout(timer);
  }
}
