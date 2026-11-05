/**
 * Cardinal 命令识别（纯函数，零依赖，可单测）。
 *
 * OpenClaw 的 before_agent_reply 钩子拿到的是 prepared run prompt（cleanedBody），
 * 可能带有通道上下文前缀，例如：
 *   [微信 · DM] user123:
 *   /list
 * 因此按行扫描，命中规则是「某一行以 /命令词 开头」——命令必须在行首。
 *
 * 为什么必须是行首：否则普通对话里提到命令（「看看 /list 怎么用」「路径是 /usr/list」）
 * 会被误判成命令、整条消息被枢机截走，用户就再也问不了关于命令的问题。
 */

export const CARDINAL_COMMANDS = [
  '/ping',
  '/list',
  '/status',
  '/tasks',
  '/cost',
  '/dispatch',
  '/confirm',
  '/help',
] as const;

/** 命令词 + 边界：词后必须是行尾或空白，/listx 不算 */
const LINE_COMMAND_RE = /^\/(ping|list|status|tasks|cost|dispatch|confirm|help)(?=$|\s)/;

/** 前缀最大长度：超过就不是通道前缀，而是用户真在写长文本 */
const MAX_PREFIX_LEN = 60;

/**
 * 从 prepared prompt 中提取 Cardinal 命令文本；非命令返回 null。
 * 支持两种前缀形态：换行后的独立命令行、以及「前缀: /list」同行形态。
 */
export function extractCommand(body: string): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  for (const rawLine of body.split('\n')) {
    let line = rawLine.trim();
    if (!line.startsWith('/')) {
      const colon = line.indexOf(':');
      if (colon >= 0 && colon <= MAX_PREFIX_LEN) {
        const rest = line.slice(colon + 1).trim();
        if (rest.startsWith('/')) line = rest;
      }
    }
    if (LINE_COMMAND_RE.test(line)) return line.length > 0 ? line : null;
  }
  return null;
}

/** 是否是已知的 Cardinal 命令词（用于帮助文本/自检）。 */
export function isCardinalCommandWord(word: string): boolean {
  return (CARDINAL_COMMANDS as readonly string[]).includes(word);
}
