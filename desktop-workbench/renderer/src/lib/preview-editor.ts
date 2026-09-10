import { HighlightStyle } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"
import type { Extension } from "@codemirror/state"
import { cpp } from "@codemirror/lang-cpp"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { java } from "@codemirror/lang-java"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { php } from "@codemirror/lang-php"
import { python } from "@codemirror/lang-python"
import { sql, MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql"
import { xml } from "@codemirror/lang-xml"
import { yaml } from "@codemirror/lang-yaml"
import { StreamLanguage } from "@codemirror/language"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { toml } from "@codemirror/legacy-modes/mode/toml"

export const previewHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], class: "cm-aa-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "cm-aa-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "cm-aa-literal" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "cm-aa-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], class: "cm-aa-function" },
  { tag: [t.className, t.typeName, t.namespace], class: "cm-aa-type" },
  { tag: [t.propertyName, t.attributeName], class: "cm-aa-property" },
  { tag: [t.variableName, t.definition(t.variableName)], class: "cm-aa-variable" },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], class: "cm-aa-operator" },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket, t.paren], class: "cm-aa-punctuation" },
  { tag: [t.heading, t.strong], class: "cm-aa-heading" },
  { tag: [t.emphasis, t.link], class: "cm-aa-emphasis" },
])

export function languageForFile(filename: string): Extension {
  const lower = filename.toLowerCase()
  const basename = lower.split(/[\\/]/).pop() ?? lower
  const ext = basename.split(".").pop() ?? ""
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    return javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext.endsWith("x") })
  }
  if (ext === "json") return json()
  if (["md", "markdown", "mdx"].includes(ext)) return markdown()
  if (["py", "pyi"].includes(ext)) return python()
  if (["html", "htm"].includes(ext)) return html()
  if (["css", "scss", "sass"].includes(ext)) return css()
  if (["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ino"].includes(ext)) return cpp()
  if (ext === "java") return java()
  if (ext === "sql") return sql()
  if (ext === "mysql") return sql({ dialect: MySQL })
  if (["pgsql", "psql"].includes(ext)) return sql({ dialect: PostgreSQL })
  if (["sqlite", "sqlite3", "db"].includes(ext)) return sql({ dialect: SQLite })
  if (["xml", "svg", "xhtml", "rss", "atom", "plist"].includes(ext)) return xml()
  if (["yaml", "yml"].includes(ext)) return yaml()
  if (ext === "toml") return StreamLanguage.define(toml)
  if (["php", "phtml"].includes(ext)) return php()
  if (["sh", "bash", "zsh"].includes(ext)) return StreamLanguage.define(shell)
  if (basename.endsWith(".json")) return json()
  if (basename.endsWith(".toml")) return StreamLanguage.define(toml)
  return []
}
