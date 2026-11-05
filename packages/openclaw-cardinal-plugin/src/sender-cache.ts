/**
 * 发送者身份缓存（纯函数式，零依赖，可单测）。
 *
 * 为什么需要它：`before_agent_reply` 钩子只拿到 prepared prompt（cleanedBody）和
 * 会话级 ctx（sessionKey 等），**没有发送者 ID**；而枢机桥的白名单终审必须知道
 * 「这条微信是谁发的」。OpenClaw 的 `message_received` 观察钩子才带 senderId，
 * 因此在这里按 sessionKey 记下来，供 reply 钩子取用。
 *
 * 取不到的后果是 fail-closed：桥会以未知身份拒绝——这正是红线想要的方向。
 */

export interface SenderRecord {
  senderId: string;
  from?: string;
  at: number;
}

export interface SenderCache {
  set(key: string, record: SenderRecord): void;
  get(key: string): SenderRecord | null;
  prune(): void;
  size(): number;
}

export function createSenderCache({
  ttlMs = 10 * 60 * 1000,
  max = 200,
  now = () => Date.now(),
}: { ttlMs?: number; max?: number; now?: () => number } = {}): SenderCache {
  const map = new Map<string, SenderRecord>();

  function prune() {
    const t = now();
    for (const [k, v] of map) {
      if (t - v.at > ttlMs) map.delete(k);
    }
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  return {
    set(key, record) {
      if (!key) return;
      map.set(key, record);
      prune(); // 先插入再清扫：保证 size 永远不超过 max
    },
    get(key) {
      if (!key) return null;
      const rec = map.get(key);
      if (!rec) return null;
      if (now() - rec.at > ttlMs) {
        map.delete(key);
        return null;
      }
      return rec;
    },
    prune,
    size: () => map.size,
  };
}

/**
 * 兜底：从 prepared prompt 的通道前缀里猜发送者。
 * 形如 `[微信 · DM] user123:` / `Telegram 42: /list` → 取冒号前最后一段标识。
 * 猜不到返回 null（让上层 fail-closed）。
 */
export function senderFromPrefix(body: string): string | null {
  if (typeof body !== 'string') return null;
  const firstLine = body.split('\n', 1)[0] ?? '';
  const colon = firstLine.indexOf(':');
  if (colon <= 0) return null;
  const head = firstLine.slice(0, colon).trim();
  if (head.length === 0 || head.length > 60) return null;
  // 取最后一段（去掉 `[微信 · DM]` 之类的通道标签），要求不含空格才算身份标识
  const candidate = head.split(/\s+/).pop() ?? '';
  if (!candidate || /\s/.test(candidate)) return null;
  return candidate;
}

/**
 * 发送者解析（纯函数，顺序固定，可单测）：
 *   message_received 缓存 → prepared prompt 前缀 → ''（桥侧拒绝，fail-closed）
 */
export function resolveSender(cached: SenderRecord | null, body: string): string {
  return cached?.senderId || senderFromPrefix(body) || '';
}
