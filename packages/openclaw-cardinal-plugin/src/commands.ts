/**
 * Cardinal 命令识别（纯函数，零依赖，可单测）。
 *
 * OpenClaw 的 before_agent_reply 钩子拿到的是 prepared run prompt（cleanedBody），
 * 可能带有通道上下文前缀，因此用「行内 /命令词 + 边界」匹配，命中后取该行剩余部分。
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

const COMMAND_RE = /(^|\s)\/(ping|list|status|tasks|cost|dispatch|confirm|help)(?=$|\s)/;

/** 从 prepared prompt 中提取 Cardinal 命令文本；非命令返回 null。 */
export function extractCommand(body: string): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  const m = body.match(COMMAND_RE);
  if (!m || m.index === undefined) return null;
  const slashAt = m.index + m[0].indexOf('/');
  const rest = body.slice(slashAt);
  const nl = rest.indexOf('\n');
  const line = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
  return line.length > 0 ? line : null;
}

/** 是否是已知的 Cardinal 命令词（用于帮助文本/自检）。 */
export function isCardinalCommandWord(word: string): boolean {
  return (CARDINAL_COMMANDS as readonly string[]).includes(word);
}
