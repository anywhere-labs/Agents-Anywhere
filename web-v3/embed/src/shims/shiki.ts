// `shiki` for the mobile render bundle (aliased in embed/vite.config.ts): the same API @streamdown/code imports
// (`bundledLanguagesInfo`, `bundledLanguages`, `createHighlighter`), over a curated set of grammars and the two themes
// the app uses. The full bundle's ~300 grammars would be inlined into the single HTML file; anything outside this
// list shows as plain text (the plugin's own fallback).
import { createBundledHighlighter } from "shiki/core"
import type { BundledLanguageInfo, DynamicImportLanguageRegistration, DynamicImportThemeRegistration } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

export const bundledLanguagesInfo: BundledLanguageInfo[] = [
  // TypeScript's grammar also colours JavaScript, JSX and TSX well enough (the four grammars are ~190 KB each).
  {
    id: "typescript",
    name: "TypeScript",
    aliases: ["ts", "mts", "cts", "tsx", "javascript", "js", "mjs", "cjs", "jsx"],
    import: () => import("@shikijs/langs/typescript"),
  },
  { id: "json", name: "JSON", import: () => import("@shikijs/langs/json") },
  { id: "jsonc", name: "JSON with Comments", aliases: ["json5"], import: () => import("@shikijs/langs/jsonc") },
  { id: "shellscript", name: "Shell", aliases: ["bash", "sh", "shell", "zsh", "console"], import: () => import("@shikijs/langs/shellscript") },
  { id: "python", name: "Python", aliases: ["py"], import: () => import("@shikijs/langs/python") },
  { id: "go", name: "Go", import: () => import("@shikijs/langs/go") },
  { id: "rust", name: "Rust", aliases: ["rs"], import: () => import("@shikijs/langs/rust") },
  { id: "java", name: "Java", import: () => import("@shikijs/langs/java") },
  { id: "kotlin", name: "Kotlin", aliases: ["kt", "kts"], import: () => import("@shikijs/langs/kotlin") },
  { id: "swift", name: "Swift", import: () => import("@shikijs/langs/swift") },
  { id: "c", name: "C", aliases: ["h"], import: () => import("@shikijs/langs/c") },
  { id: "css", name: "CSS", aliases: ["scss", "less"], import: () => import("@shikijs/langs/css") },
  // HTML's own grammar embeds JavaScript and CSS; XML's is close enough for markup.
  { id: "xml", name: "XML", aliases: ["html", "svg", "plist", "vue"], import: () => import("@shikijs/langs/xml") },
  { id: "yaml", name: "YAML", aliases: ["yml"], import: () => import("@shikijs/langs/yaml") },
  { id: "toml", name: "TOML", import: () => import("@shikijs/langs/toml") },
  { id: "ini", name: "INI", aliases: ["properties", "dotenv", "env"], import: () => import("@shikijs/langs/ini") },
  { id: "sql", name: "SQL", import: () => import("@shikijs/langs/sql") },
  { id: "diff", name: "Diff", aliases: ["patch"], import: () => import("@shikijs/langs/diff") },
  { id: "docker", name: "Dockerfile", aliases: ["dockerfile"], import: () => import("@shikijs/langs/docker") },
  { id: "make", name: "Makefile", aliases: ["makefile"], import: () => import("@shikijs/langs/make") },
  { id: "lua", name: "Lua", import: () => import("@shikijs/langs/lua") },
]

export const bundledLanguages: Record<string, DynamicImportLanguageRegistration> = Object.fromEntries(
  bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])].map((name) => [name, l.import]))
)

const bundledThemes: Record<string, DynamicImportThemeRegistration> = {
  "github-light": () => import("@shikijs/themes/github-light"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
}

export const createHighlighter = createBundledHighlighter<string, string>({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
})
