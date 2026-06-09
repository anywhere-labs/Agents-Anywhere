import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

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
    code({ className, children }) {
      const isBlock = Boolean(className);
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
