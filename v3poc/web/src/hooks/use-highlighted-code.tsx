import * as React from "react"

import { codeHighlighter } from "@/lib/highlighter"

type Tokens = NonNullable<ReturnType<typeof codeHighlighter.highlight>>["tokens"]

/**
 * AI Elements' Code Block hook, on Streamdown's Shiki plugin: one React node per line. The plugin answers from its cache
 * at once, or later through the callback; while a block streams, lines that have not changed keep the colours of the
 * last result and only the new ones show plain until it arrives, so nothing flickers.
 */
export function useHighlightedCode(value: string, language: string, isIncomplete = false) {
  // A trailing newline would render as an extra empty line.
  const code = value.endsWith("\n") ? value.slice(0, -1) : value
  const [result, setResult] = React.useState<{ language: string; tokens: Tokens } | null>(null)

  React.useEffect(() => {
    let live = true
    const sync = codeHighlighter.highlight(
      { code, language: (language || "text") as Parameters<typeof codeHighlighter.highlight>[0]["language"], themes: codeHighlighter.getThemes(), isIncomplete },
      (r) => {
        if (live) setResult({ language, tokens: r.tokens })
      }
    )
    if (sync) setResult({ language, tokens: sync.tokens })
    return () => {
      live = false
    }
  }, [code, language, isIncomplete])

  return React.useMemo(() => {
    const lines = code.split("\n")
    const tokens = result?.language === language ? result.tokens : []
    return lines.map((line, i) => {
      const row = tokens[i]
      if (!row || row.map((t) => t.content).join("") !== line) return line
      return row.map((t, j) => (
        <span
          key={j}
          style={{ "--shiki-light": t.htmlStyle?.color ?? t.color, "--shiki-dark": t.htmlStyle?.["--shiki-dark"] } as React.CSSProperties}
          className="text-(--shiki-light) dark:text-(--shiki-dark)"
        >
          {t.content}
        </span>
      ))
    })
  }, [code, language, result])
}
