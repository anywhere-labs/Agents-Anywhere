import type { ReactNode } from "react"
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import cpp from "highlight.js/lib/languages/cpp"
import csharp from "highlight.js/lib/languages/csharp"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import dart from "highlight.js/lib/languages/dart"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import go from "highlight.js/lib/languages/go"
import graphql from "highlight.js/lib/languages/graphql"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import lua from "highlight.js/lib/languages/lua"
import makefile from "highlight.js/lib/languages/makefile"
import markdown from "highlight.js/lib/languages/markdown"
import nginx from "highlight.js/lib/languages/nginx"
import objectivec from "highlight.js/lib/languages/objectivec"
import php from "highlight.js/lib/languages/php"
import plaintext from "highlight.js/lib/languages/plaintext"
import powershell from "highlight.js/lib/languages/powershell"
import properties from "highlight.js/lib/languages/properties"
import python from "highlight.js/lib/languages/python"
import r from "highlight.js/lib/languages/r"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import shell from "highlight.js/lib/languages/shell"
import sql from "highlight.js/lib/languages/sql"
import swift from "highlight.js/lib/languages/swift"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

const languageAliases: Record<string, string> = {
  c: "cpp",
  cc: "cpp",
  cjs: "javascript",
  conf: "nginx",
  cs: "csharp",
  csx: "csharp",
  docker: "dockerfile",
  h: "cpp",
  hpp: "cpp",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  m: "objectivec",
  make: "makefile",
  md: "markdown",
  mk: "makefile",
  mm: "objectivec",
  mjs: "javascript",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  text: "plaintext",
  ts: "typescript",
  tsx: "typescript",
  gql: "graphql",
  yml: "yaml",
  zsh: "bash",
}

let registered = false

function registerLanguages() {
  if (registered) return
  registered = true
  hljs.registerLanguage("bash", bash)
  hljs.registerLanguage("cpp", cpp)
  hljs.registerLanguage("csharp", csharp)
  hljs.registerLanguage("css", css)
  hljs.registerLanguage("dart", dart)
  hljs.registerLanguage("diff", diff)
  hljs.registerLanguage("dockerfile", dockerfile)
  hljs.registerLanguage("go", go)
  hljs.registerLanguage("graphql", graphql)
  hljs.registerLanguage("ini", ini)
  hljs.registerLanguage("java", java)
  hljs.registerLanguage("javascript", javascript)
  hljs.registerLanguage("json", json)
  hljs.registerLanguage("kotlin", kotlin)
  hljs.registerLanguage("lua", lua)
  hljs.registerLanguage("makefile", makefile)
  hljs.registerLanguage("markdown", markdown)
  hljs.registerLanguage("nginx", nginx)
  hljs.registerLanguage("objectivec", objectivec)
  hljs.registerLanguage("php", php)
  hljs.registerLanguage("plaintext", plaintext)
  hljs.registerLanguage("powershell", powershell)
  hljs.registerLanguage("properties", properties)
  hljs.registerLanguage("python", python)
  hljs.registerLanguage("r", r)
  hljs.registerLanguage("ruby", ruby)
  hljs.registerLanguage("rust", rust)
  hljs.registerLanguage("shell", shell)
  hljs.registerLanguage("sql", sql)
  hljs.registerLanguage("swift", swift)
  hljs.registerLanguage("typescript", typescript)
  hljs.registerLanguage("xml", xml)
  hljs.registerLanguage("yaml", yaml)
}

export function highlightCode(code: string, language: string): ReactNode {
  registerLanguages()
  const normalized = normalizeLanguage(language)
  try {
    const highlighted = hljs.getLanguage(normalized)
      ? hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
      : hljs.highlight(code, { language: "plaintext", ignoreIllegals: true }).value
    return <span dangerouslySetInnerHTML={{ __html: highlighted }} />
  } catch {
    return code
  }
}

function normalizeLanguage(language: string) {
  const key = language.trim().toLowerCase()
  return languageAliases[key] ?? key
}
