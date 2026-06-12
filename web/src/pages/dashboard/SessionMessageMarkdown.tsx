import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Icons } from "../../components/Icons";
import { highlightCode } from "../../lib/codeHighlight";

const remarkPlugins = [remarkGfm];

// Removes a trailing :line or :line:col suffix from a path string.
function stripLine(path: string): string {
  return path.replace(/:\d+(:\d+)?$/, "");
}

// Returns the file path (sans :line) if text looks like a file ref, else null.
// Criteria: contains "/", ends with ".<ext>" (optionally ":line"), no spaces,
// no "://".
function parseFileRef(text: string): string | null {
  if (!text || text.includes(" ") || text.includes("://")) return null;
  if (!text.includes("/")) return null;
  if (!/\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?$/.test(text)) return null;
  return stripLine(text);
}

// Returns true if href looks like a local file path rather than a URL/anchor.
function isFilePath(href: string): boolean {
  if (!href) return false;
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#") ||
    href.startsWith("//")
  ) {
    return false;
  }
  return true;
}

function makeComponents(onOpenFile?: (path: string) => void): Components {
  return {
    a({ href, children }) {
      if (href && isFilePath(href) && onOpenFile) {
        const path = stripLine(href);
        return (
          <span
            className="kl-file-link"
            role="button"
            tabIndex={0}
            onClick={() => onOpenFile(path)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenFile(path); }}
          >
            {children}
          </span>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children;
      if (
        child &&
        typeof child === "object" &&
        "props" in child &&
        child.props &&
        typeof child.props === "object"
      ) {
        const props = child.props as {
          className?: string;
          children?: ReactNode;
        };
        const raw = textFromChildren(props.children);
        const language = languageFromClassName(props.className);
        return (
          <CodePanel
            label={language || "code"}
            code={raw}
            className={props.className}
          />
        );
      }
      return <pre>{children}</pre>;
    },
    code({ className, children }) {
      const isBlock = Boolean(className);
      if (isBlock) return <code className={className}>{children}</code>;
      if (!isBlock && typeof children === "string" && onOpenFile) {
        const path = parseFileRef(children);
        if (path) {
          return (
            <code
              className="kl-file-link"
              role="button"
              tabIndex={0}
              onClick={() => onOpenFile(path)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenFile(path); }}
            >
              {children}
            </code>
          );
        }
      }
      return <code className={className}>{children}</code>;
    },
  };
}

function CodePanel({
  label,
  code,
  className,
}: {
  label: string;
  code: string;
  className?: string;
}) {
  return (
    <div className="kl-code-panel">
      <span className="kl-code-panel-label">{label}</span>
      <CopyButton text={code} label="Copy code" />
      <pre className="kl-code-panel-body">
        <code className={className}>{highlightCode(code, label)}</code>
      </pre>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const disabled = !text;
  const copy = async () => {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      className={"kl-copy-btn" + (copied ? " ok" : "")}
      onClick={copy}
      disabled={disabled}
      aria-label={label}
      title={copied ? "Copied" : label}
    >
      {copied ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
    </button>
  );
}

function languageFromClassName(className: string | undefined): string {
  const match = /language-([^\s]+)/.exec(className ?? "");
  return match?.[1] ?? "";
}

function textFromChildren(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children).replace(/\n$/, "");
  }
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  return "";
}

export const SessionMessageMarkdown = memo(function SessionMessageMarkdown({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  const components = useMemo(() => makeComponents(onOpenFile), [onOpenFile]);
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});
