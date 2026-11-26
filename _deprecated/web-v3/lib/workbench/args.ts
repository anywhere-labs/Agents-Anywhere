/**
 * An agent's arguments as one line of text in its settings, the way a shell would read them: split on spaces, with
 * "double" or 'single' quotes keeping spaces in one argument and a backslash escaping the next character (outside
 * single quotes). `joinArgs` writes them back so that `splitArgs(joinArgs(a))` gives `a` again.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ""
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (c === "\\" && i + 1 < text.length) {
      cur += text[++i]
      started = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started) out.push(cur)
      cur = ""
      started = false
      continue
    }
    cur += c
    started = true
  }
  if (started) out.push(cur)
  return out
}

export function joinArgs(args: readonly string[]): string {
  return args
    .map((a) => (a === "" ? "''" : /[\s"'\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))
    .join(" ")
}
