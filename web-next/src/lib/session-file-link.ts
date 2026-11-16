// Resolves Markdown link destinations from agent messages into a path on the
// work device. Shared by the `a` and inline `code` renderers so a file link in
// the assistant reply opens the in-session preview tab instead of a plain link.
//
// The parsing mirrors the Android client (SessionFileLinks.kt) so Web/Desktop
// accept the same shapes: `file://` URIs, percent-encoded paths, `~` / absolute
// / relative / Windows drive / UNC paths, and the `:12`, `:12:3` and `#L12`
// line suffixes agents append.

const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/
const LINE_ANCHOR = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/
const LINE_SUFFIX = /:\d+(?:-\d+)?(?::\d+)?$/
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const PATH_ROOT = /^(?:\/|~[/\\]|\.{1,2}[/\\]|[A-Za-z]:[/\\]|\\\\)/
const EXTENSION = /^[a-z0-9]+$/
const SHELL_SYNTAX = /[|&;<>`*?"]|\$\(|(?:^|\s)-{1,2}[A-Za-z]/

/** First words that turn `open report.pdf` into a command rather than a file name. */
const COMMAND_WORDS = new Set([
  "bash", "cat", "cd", "code", "cp", "echo", "explorer", "git", "head", "less", "libreoffice",
  "ls", "more", "mv", "nano", "node", "npm", "npx", "open", "pandoc", "pnpm", "python",
  "python3", "rm", "sh", "soffice", "start", "tail", "touch", "type", "vi", "vim",
  "xdg-open", "yarn", "zsh",
])

/**
 * Extensions an agent means as a generated document even without a directory
 * prefix (e.g. `报告.pdf`). Bare code names such as `console.log` stay plain.
 */
const STANDALONE_FILE_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "docm", "dot", "dotx", "rtf", "odt", "pages",
  "ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key",
  "xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv",
  "html", "htm", "xhtml", "md", "markdown", "txt", "epub",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "svg",
  "zip", "mp3", "mp4", "mov", "wav", "m4a",
])

/**
 * The protocols a Markdown link destination must use to stay a web/navigation
 * link. Everything else is treated as a work-device file path and routes to
 * the preview tab. `file:` is deliberately kept (react-markdown's default
 * allow-list drops it, which turns `file://` links into empty `href`s).
 */
const SAFE_URL_SCHEME = /^(https?|ircs?|mailto|xmpp)$/i

/**
 * `urlTransform` for react-markdown. Keeps `file:` and Windows drive-letter
 * destinations (both are stripped by the default transform) and still removes
 * genuinely dangerous schemes such as `javascript:` / `data:`.
 */
export function markdownUrlTransform(value: string): string {
  if (WINDOWS_DRIVE.test(value)) return value

  const colon = value.indexOf(":")
  const questionMark = value.indexOf("?")
  const numberSign = value.indexOf("#")
  const slash = value.indexOf("/")

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign)
  ) {
    return value
  }

  const scheme = value.slice(0, colon)
  if (scheme.toLowerCase() === "file" || SAFE_URL_SCHEME.test(scheme)) {
    return value
  }
  return ""
}

/**
 * Whether a link destination should stay a navigation link (web URL, mailto,
 * protocol-relative URL, or a pure anchor) instead of opening the preview tab.
 */
export function isExternalMarkdownHref(href: string): boolean {
  if (!href) return false
  if (href.startsWith("#") || href.startsWith("//")) return true
  const scheme = URI_SCHEME.exec(href)?.[1]
  if (!scheme) return false
  return scheme.toLowerCase() !== "file"
}

/**
 * Turns a Markdown link destination into a path on the work device, or returns
 * null when it is not a file reference. Resolve failures are the caller's
 * concern: the preview tab renders its own "unsupported / not found" state.
 */
export function sessionFileLinkPath(destination: string): string | null {
  let value = destination.trim()
  if (value.length >= 2 && value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim()
  }
  if (!value || value.startsWith("#") || value.startsWith("//")) return null

  const scheme = URI_SCHEME.exec(value)?.[1]
  if (scheme) {
    if (scheme.toLowerCase() !== "file") return null
    return fileUriPath(value.slice(scheme.length + 1))
  }

  value = value.replace(LINE_ANCHOR, "")
  value = decodePercentEscapes(value) ?? value
  return cleanFilePath(value)
}

/**
 * Returns the path an inline code span such as `` `docs/报告 终稿.pdf:3` ``
 * refers to, or null when the code is not a file reference. More conservative
 * than `sessionFileLinkPath`: bare names and spaced paths only count when they
 * end with a document/image/media extension and contain no shell syntax, so
 * commands like `ls -la out/report.pdf` stay plain code.
 */
export function inlineCodeFilePath(code: string): string | null {
  const text = code.trim()
  if (!text) return null
  if (text.toLowerCase().startsWith("file:")) return sessionFileLinkPath(text)
  if (text.includes("://") || text.includes("\n")) return null

  const candidate = text.replace(LINE_SUFFIX, "")
  const name = candidate.split("/").at(-1)!.split("\\").at(-1)!
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : ""
  if (!extension || name.slice(0, name.lastIndexOf(".")) === "") return null
  if (!EXTENSION.test(extension)) return null

  const hasSeparator = candidate.includes("/") || candidate.includes("\\")
  const hasWhitespace = /\s/.test(candidate)
  if (hasWhitespace || !hasSeparator) {
    if (!STANDALONE_FILE_EXTENSIONS.has(extension)) return null
    if (SHELL_SYNTAX.test(candidate)) return null
    const firstWord = candidate.split(" ")[0] ?? ""
    if (hasWhitespace && COMMAND_WORDS.has(firstWord.toLowerCase())) return null
    const firstSegment = (candidate.split("/")[0] ?? "").split("\\")[0] ?? ""
    if (hasWhitespace && hasSeparator && !PATH_ROOT.test(candidate) && /\s/.test(firstSegment)) {
      // `open out/a.pdf`: the first word reads like a command, not a folder.
      return null
    }
  }
  return cleanFilePath(candidate)
}

function fileUriPath(afterScheme: string): string | null {
  // A literal `#` or `?` in a file URI is always percent-encoded, so both
  // start a suffix here (query or `#L12`-style line anchor).
  const rest = afterScheme.split("?")[0]?.split("#")[0] ?? ""
  let path: string
  if (rest.startsWith("//")) {
    const authorityEnd = rest.indexOf("/", 2)
    const authority = authorityEnd < 0 ? rest.slice(2) : rest.slice(2, authorityEnd)
    const remainder = authorityEnd < 0 ? "" : rest.slice(authorityEnd)
    path = !authority || authority.toLowerCase() === "localhost"
      ? remainder
      : `//${authority}${remainder}` // file://server/share/report.pdf → UNC
  } else {
    path = rest
  }
  return cleanFilePath(decodePercentEscapes(path) ?? path)
}

function cleanFilePath(raw: string): string | null {
  const withoutLine = raw.trim().replace(LINE_SUFFIX, "")
  const value = normalizeRemotePath(withoutLine).trim()
  return value || null
}

/**
 * The server marks a Windows drive root with a leading slash (`/C:/…`). Strip
 * it so the path matches the device's canonical form (`C:/…`).
 */
function normalizeRemotePath(rawPath: string): string {
  return rawPath.replace(/^\/([A-Za-z]:)(?=$|[\\/])/, "$1")
}

/**
 * Decodes `%XX` escapes as UTF-8. Returns null when the text has no escapes or
 * the bytes are not valid UTF-8, in which case callers keep the raw text (a
 * file may legitimately be named `100%.md`).
 */
export function decodePercentEscapes(value: string): string | null {
  if (!PERCENT_ESCAPE.test(value)) return null

  const encoder = new TextEncoder()
  const bytes: number[] = []
  let index = 0
  while (index < value.length) {
    const char = value[index]!
    if (char === "%" && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        index += 3
        continue
      }
    }
    const isHigh = char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdbff
    const end = isHigh && index + 1 < value.length ? index + 2 : index + 1
    bytes.push(...encoder.encode(value.slice(index, end)))
    index = end
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}