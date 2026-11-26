"use client"

// Syntax highlighting for every code block in the thread (Markdown fences, file reads, diffs), through Streamdown's own
// Shiki plugin (@streamdown/code), so there is one Shiki in the app and Streamdown, Code Block and the tool details
// share its highlighter, grammar cache and incremental streaming tokenizer.
//
// Loaded the first time something is highlighted, not at start-up: the renderer's start-up time is the time to its
// first frame, and Shiki (with its regex engine) is a large part of the script. Until it is there, code shows plain and
// the result arrives through the callback, which is how the plugin answers an uncached request anyway.
import type { CodeHighlighterPlugin } from '@streamdown/code'

type Plugin = CodeHighlighterPlugin
const THEMES: ReturnType<Plugin['getThemes']> = ['github-light', 'github-dark']

let real: Plugin | null = null
let loading: Promise<Plugin> | null = null
const load = () =>
  (loading ??= import('@streamdown/code').then((m) => {
    real = m.createCodePlugin({ themes: THEMES })
    return real
  }))

export const codeHighlighter: Plugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => THEMES,
  getSupportedLanguages: () => real?.getSupportedLanguages() ?? [],
  // Before it has loaded: say yes, and fall back to plain text if the language turns out not to be there.
  supportsLanguage: (language) => real?.supportsLanguage(language) ?? true,
  highlight(options, callback) {
    if (real) return real.highlight(options, callback)
    void load().then((p) => {
      const sync = p.highlight(options, callback)
      if (sync) callback?.(sync)
    })
    return null
  },
}
