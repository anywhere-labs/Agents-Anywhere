"use client"

import * as React from "react"

import { codeHighlighter } from "@/lib/highlighter"

type Tokens = NonNullable<ReturnType<typeof codeHighlighter.highlight>>["tokens"]

/**
 * AI Elements' Code Block hook, on Streamdown's Shiki plugin: one React node per line. The plugin answers from its cache
 * at once, or later through the callback; while a block streams, lines that have not changed keep the colours of the
 * last result and only the new ones show plain until it arrives, so nothing flickers.
 */
export function useHighlightedCode(value: string, language: string, isIncomplete = false) {
  const code = value.endsWith("\n") ? value.slice(0, -1) : value
  const [asyncResult, setAsyncResult] = React.useState<{
    code: string
    language: string
    tokens: Tokens
  } | null>(null)

  const syncTokens = React.useMemo(() => {
    const res = codeHighlighter.highlight({
      code,
      language: (language || "text") as Parameters<typeof codeHighlighter.highlight>[0]["language"],
      themes: codeHighlighter.getThemes(),
      isIncomplete,
    })
    return res?.tokens ?? null
  }, [code, language, isIncomplete])

  React.useEffect(() => {
    if (syncTokens) return
    let live = true
    const sync = codeHighlighter.highlight(
      {
        code,
        language: (language || "text") as Parameters<typeof codeHighlighter.highlight>[0]["language"],
        themes: codeHighlighter.getThemes(),
        isIncomplete,
      },
      (r) => {
        if (live) setAsyncResult({ code, language, tokens: r.tokens })
      }
    )
    if (sync) {
      queueMicrotask(() => {
        if (live) setAsyncResult({ code, language, tokens: sync.tokens })
      })
    }
    return () => {
      live = false
    }
  }, [code, language, isIncomplete, syncTokens])

  return React.useMemo(() => {
    const lines = code.split("\n")
    const tokens =
      syncTokens ??
      (asyncResult?.language === language && asyncResult.code === code ? asyncResult.tokens : [])
    return lines.map((line, i) => {
      const row = tokens[i]
      if (!row || row.map((t) => t.content).join("") !== line) return line
      return row.map((t, j) => (
        <span
          key={j}
          style={
            {
              "--shiki-light": t.htmlStyle?.color ?? t.color,
              "--shiki-dark": t.htmlStyle?.["--shiki-dark"],
            } as React.CSSProperties
          }
          className="text-(--shiki-light) dark:text-(--shiki-dark)"
        >
          {t.content}
        </span>
      ))
    })
  }, [code, language, syncTokens, asyncResult])
}
