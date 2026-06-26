"use client"

import * as React from "react"

export type MonacoCodeViewApi = {
  getValue: () => string
  focus: () => void
  openSearch: () => void
  destroy: () => void
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker
    }
  }
}

type MonacoCodeViewProps = {
  className?: string
  content: string
  editable?: boolean
  fileName?: string
  language?: string
  onChange?: (value: string) => void
  onReady?: (api: MonacoCodeViewApi) => void
  options?: import("monaco-editor").editor.IStandaloneEditorConstructionOptions
  style?: React.CSSProperties
}

export function MonacoCodeView({
  className,
  content,
  editable = false,
  fileName,
  language,
  onChange,
  onReady,
  options,
  style,
}: MonacoCodeViewProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const onChangeRef = React.useRef(onChange)
  const onReadyRef = React.useRef(onReady)

  React.useEffect(() => {
    onChangeRef.current = onChange
    onReadyRef.current = onReady
  }, [onChange, onReady])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let editor: import("monaco-editor").editor.IStandaloneCodeEditor | null = null
    let disposed = false
    let cleanup = () => {
      if (disposed) return
      disposed = true
      safeDispose(() => editor?.getModel()?.dispose())
      safeDispose(() => editor?.dispose())
    }
    let cancelled = false
    ;(async () => {
      const monaco = await import("monaco-editor")
      await loadMonacoLanguages()
      if (cancelled) return
      configureMonacoEnvironment()
      defineMonacoThemes(monaco)
      const model = monaco.editor.createModel(content, monacoLanguageForName(language) ?? monacoLanguageForFile(fileName ?? ""))
      editor = monaco.editor.create(host, {
        model,
        automaticLayout: true,
        contextmenu: true,
        lineNumbers: "on",
        minimap: { enabled: false },
        readOnly: !editable,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        theme: currentMonacoTheme(),
        wordWrap: "off",
        ...options,
      })
      const themeObserver = new MutationObserver(() => {
        monaco.editor.setTheme(currentMonacoTheme())
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      const changeDisposable = editor.onDidChangeModelContent(() => onChangeRef.current?.(editor?.getValue() ?? content))
      cleanup = () => {
        if (disposed) return
        disposed = true
        safeDispose(() => changeDisposable.dispose())
        safeDispose(() => themeObserver.disconnect())
        safeDispose(() => model.dispose())
        safeDispose(() => editor?.dispose())
      }
      onReadyRef.current?.({
        getValue: () => editor?.getValue() ?? content,
        focus: () => editor?.focus(),
        openSearch: () => {
          editor?.getAction("actions.find")?.run()
        },
        destroy: cleanup,
      })
      if (editable) window.setTimeout(() => editor?.focus(), 0)
    })()
    return () => {
      cancelled = true
      cleanup()
    }
  }, [content, editable, fileName, language, options])

  return <div ref={hostRef} className={className} style={style} />
}

function safeDispose(dispose: () => void) {
  try {
    dispose()
  } catch (error) {
    if (isMonacoCanceledError(error)) return
    throw error
  }
}

function isMonacoCanceledError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.message === "Canceled" || error.name === "Canceled" || error.name === "CanceledError"
}

let monacoEnvironmentConfigured = false
let monacoThemesDefined = false
let monacoLanguagesLoaded: Promise<void> | null = null

function loadMonacoLanguages() {
  monacoLanguagesLoaded ??= Promise.all([
    import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/css/css.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/java/java.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/php/php.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/r/r.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js"),
  ]).then(() => undefined)
  return monacoLanguagesLoaded
}

function configureMonacoEnvironment() {
  if (monacoEnvironmentConfigured) return
  monacoEnvironmentConfigured = true
  window.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string) => {
      if (label === "json") {
        return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" })
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" })
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" })
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" })
      }
      return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" })
    },
  }
}

function defineMonacoThemes(monaco: typeof import("monaco-editor")) {
  if (monacoThemesDefined) return
  monacoThemesDefined = true
  registerDiffLanguage(monaco)
  monaco.editor.defineTheme("aa-preview-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "diff.header", foreground: "6e7781" },
      { token: "diff.hunk", foreground: "8250df", fontStyle: "bold" },
      { token: "diff.addition", foreground: "1a7f37" },
      { token: "diff.deletion", foreground: "cf222e" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#24292f",
      "editor.lineHighlightBackground": "#f6f8fa",
      "editorLineNumber.foreground": "#6e7781",
      "editorLineNumber.activeForeground": "#24292f",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#d0d7de",
      "input.background": "#ffffff",
      "input.border": "#d0d7de",
    },
  })
  monaco.editor.defineTheme("aa-preview-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "diff.header", foreground: "a1a1aa" },
      { token: "diff.hunk", foreground: "c084fc", fontStyle: "bold" },
      { token: "diff.addition", foreground: "86efac" },
      { token: "diff.deletion", foreground: "fca5a5" },
    ],
    colors: {
      "editor.background": "#0a0a0a",
      "editor.foreground": "#e4e4e7",
      "editor.lineHighlightBackground": "#18181b",
      "editorLineNumber.foreground": "#71717a",
      "editorLineNumber.activeForeground": "#e4e4e7",
      "editorGutter.background": "#0a0a0a",
      "editorWidget.background": "#18181b",
      "editorWidget.border": "#3f3f46",
      "input.background": "#09090b",
      "input.border": "#3f3f46",
    },
  })
}

function registerDiffLanguage(monaco: typeof import("monaco-editor")) {
  if (!monaco.languages.getLanguages().some((language) => language.id === "diff")) {
    monaco.languages.register({ id: "diff" })
  }
  monaco.languages.setMonarchTokensProvider("diff", {
    tokenizer: {
      root: [
        [/^@@.*@@.*$/, "diff.hunk"],
        [/^(diff --git|index |--- |\+\+\+ ).*$/, "diff.header"],
        [/^\+.*/, "diff.addition"],
        [/^-.*/, "diff.deletion"],
      ],
    },
  })
}

function currentMonacoTheme() {
  return document.documentElement.classList.contains("dark") ? "aa-preview-dark" : "aa-preview-light"
}

export function monacoLanguageForFile(filename: string) {
  const lower = filename.toLowerCase()
  const basename = lower.split(/[\\/]/).pop() ?? lower
  const ext = basename.split(".").pop() ?? ""
  if (["ts", "tsx"].includes(ext)) return "typescript"
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript"
  if (["json", "jsonc"].includes(ext) || basename.endsWith(".json")) return "json"
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown"
  if (["py", "pyi"].includes(ext)) return "python"
  if (["html", "htm", "xhtml"].includes(ext)) return "html"
  if (["css", "scss", "sass", "less"].includes(ext)) return "css"
  if (["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ino"].includes(ext)) return "cpp"
  if (ext === "java") return "java"
  if (["sql", "mysql", "pgsql", "psql", "sqlite"].includes(ext)) return "sql"
  if (["xml", "svg", "rss", "atom", "plist"].includes(ext)) return "xml"
  if (["yaml", "yml"].includes(ext) || basename === "docker-compose.yml" || basename === "docker-compose.yaml") return "yaml"
  if (["php", "phtml"].includes(ext)) return "php"
  if (["sh", "bash", "zsh"].includes(ext)) return "shell"
  if (["toml", "ini", "env"].includes(ext) || basename.startsWith(".env") || [".npmrc", ".yarnrc"].includes(basename)) return "ini"
  if (basename === "dockerfile" || basename.endsWith(".dockerfile")) return "dockerfile"
  if (["makefile", "gnumakefile"].includes(basename) || ext === "mk") return "makefile"
  if (["go", "rb", "swift", "kt", "kts", "cs", "dart", "lua", "r"].includes(ext)) return ext
  if (ext === "rs") return "rust"
  if (["gql", "graphql"].includes(ext)) return "graphql"
  if (["ps1", "psm1", "psd1"].includes(ext)) return "powershell"
  return "plaintext"
}

function monacoLanguageForName(language: string | undefined) {
  if (!language) return null
  const key = language.trim().toLowerCase()
  const aliases: Record<string, string> = {
    bash: "shell",
    c: "cpp",
    cc: "cpp",
    cjs: "javascript",
    cs: "csharp",
    csx: "csharp",
    docker: "dockerfile",
    h: "cpp",
    hpp: "cpp",
    js: "javascript",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    md: "markdown",
    mjs: "javascript",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    text: "plaintext",
    txt: "plaintext",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
    zsh: "shell",
  }
  return aliases[key] ?? key
}
