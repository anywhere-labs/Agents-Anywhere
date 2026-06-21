import type { ReactNode } from "react";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { sql, MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage, type Language, type LanguageSupport } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";

type Segment = {
  from: number;
  to: number;
  classes: string;
};

const codeHighlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.modifier], class: "cm-aa-keyword" },
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
]);

export function highlightCode(code: string, language: string): ReactNode {
  const parser = languageParser(language);
  if (!parser) return code;
  try {
    const tree = parser.parser.parse(code);
    const segments: Segment[] = [];
    highlightTree(tree, codeHighlighter, (from, to, classes) => {
      if (classes) segments.push({ from, to, classes });
    });
    if (segments.length === 0) return code;
    const out: ReactNode[] = [];
    let pos = 0;
    segments.forEach((segment, index) => {
      if (segment.from > pos) out.push(code.slice(pos, segment.from));
      out.push(
        <span className={segment.classes} key={`${segment.from}-${segment.to}-${index}`}>
          {code.slice(segment.from, segment.to)}
        </span>,
      );
      pos = segment.to;
    });
    if (pos < code.length) out.push(code.slice(pos));
    return out;
  } catch {
    return code;
  }
}

function languageParser(language: string): Language | StreamLanguage<unknown> | null {
  const support = languageSupport(language);
  if (!support) return null;
  return support instanceof StreamLanguage ? support : support.language;
}

function languageSupport(language: string): LanguageSupport | StreamLanguage<unknown> | null {
  const lang = language.toLowerCase();
  switch (lang) {
    case "js":
    case "jsx":
    case "javascript":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
      return json();
    case "py":
    case "python":
      return python();
    case "html":
    case "xml":
      return lang === "xml" ? xml() : html();
    case "css":
    case "scss":
    case "sass":
      return css();
    case "md":
    case "markdown":
      return markdown();
    case "yaml":
    case "yml":
      return yaml();
    case "sql":
      return sql();
    case "mysql":
      return sql({ dialect: MySQL });
    case "postgres":
    case "postgresql":
      return sql({ dialect: PostgreSQL });
    case "sqlite":
      return sql({ dialect: SQLite });
    case "java":
      return java();
    case "c":
    case "cc":
    case "cpp":
    case "c++":
    case "h":
    case "hpp":
      return cpp();
    case "php":
      return php();
    case "bash":
    case "shell":
    case "sh":
    case "zsh":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    default:
      return null;
  }
}
