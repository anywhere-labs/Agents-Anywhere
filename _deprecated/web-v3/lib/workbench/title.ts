/**
 * A new conversation's title, taken from its first message the way chat apps name a chat before anything better is
 * known: the first non-empty line, whitespace collapsed, cut at `max` characters. Empty text gives no title.
 */
export function titleFromMessage(text: string, max = 40): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0)
  if (!line) return undefined
  const chars = Array.from(line)
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : line
}
