// `drive:/…` references in replies (docs/v3/assistant-and-files-proposal.md §6.3). The server makes the canonical form
// and resolves a reference (`GET /drive/resolve?ref=…`); the client only finds references in text and links them to
// the drive page, which resolves them and shows the folder, or the file in its folder.

import { driveHref } from "@/lib/drive/paths"
import type { DriveResolveResponse } from "@/lib/types/v3"

/**
 * Where a reference ends in text: whitespace (the full-width space too), control and format characters, and what a
 * canonical reference always percent-encodes (`?`, `#`, ASCII brackets and quotes, `|`, the backtick, `\`, full-width
 * sentence punctuation, which Chinese text runs on right after). `%` is not among them: it starts an escape.
 */
const REF_END = /[\s\p{Cc}\p{Cf}?#()[\]<>"'|`\\。，、；：！？]/u
/** Punctuation right after a reference is not part of it; a name that ends in one is written `<drive:/…>`. */
const TRAILING_PUNCTUATION = /[.,;:!]+$/
/**
 * A full-width closing bracket or quote ends a reference unless the reference opened it: `（见 drive:/a.pdf）`,
 * `“drive:/a.pdf”和…`, but `drive:/报告（终版）.pdf`. The single `’` is left out: names use it as an apostrophe.
 */
const CLOSER_OPENER: Record<string, string> = { "）": "（", "】": "【", "」": "「", "』": "『", "》": "《", "”": "“" }
const OPENERS = new Set(Object.values(CLOSER_OPENER))
/** A reference does not start inside a word, a URL or a path (`mydrive:/…`, `https://host/drive:/…`). */
const TOKEN_CHAR = /[A-Za-z0-9_\-./:@~%+]/
const REF_START = /drive:\/(?!\/)/giu

/** A whole string that is one reference: a link's target, or an inline code span. */
export function isDriveRef(text: string): boolean {
  return /^drive:\/(?!\/)[^\n]*$/iu.test(text)
}

export interface DriveRefMatch {
  /** The span the reference takes in the text, angle brackets of `<drive:/…>` included. */
  start: number
  end: number
  ref: string
}

/** The references in a stretch of plain text, in order. */
export function findDriveRefs(text: string): DriveRefMatch[] {
  const found: DriveRefMatch[] = []
  let from = 0
  for (const match of text.matchAll(REF_START)) {
    const at = match.index
    if (at < from) continue
    const before = at > 0 ? text[at - 1] : ""
    if (before === "<") {
      // `<drive:/报告/终版.>`: everything up to the closing bracket (a canonical reference encodes `<` and `>`).
      const close = text.indexOf(">", at)
      const inner = close === -1 ? "" : text.slice(at, close)
      if (close !== -1 && !inner.includes("\n") && !inner.includes("<")) {
        found.push({ start: at - 1, end: close + 1, ref: inner })
        from = close + 1
        continue
      }
    } else if (before && TOKEN_CHAR.test(before)) {
      continue
    }
    const end = scanEnd(text, at + match[0].length)
    const ref = text.slice(at, end).replace(TRAILING_PUNCTUATION, "")
    found.push({ start: at, end: at + ref.length, ref })
    from = end
  }
  return found
}

/** Where a reference that goes on from `from` ends. */
function scanEnd(text: string, from: number): number {
  const open = new Map<string, number>()
  let end = from
  for (; end < text.length; end++) {
    const ch = text[end]
    if (REF_END.test(ch)) break
    const opener = CLOSER_OPENER[ch]
    if (opener !== undefined) {
      const depth = open.get(opener) ?? 0
      if (depth === 0) break
      open.set(opener, depth - 1)
    } else if (OPENERS.has(ch)) {
      open.set(ch, (open.get(ch) ?? 0) + 1)
    }
  }
  return end
}

/** The drive page for a reference: it resolves the reference and shows what it names. */
export function driveRefHref(ref: string): string {
  return `/drive?ref=${encodeURIComponent(ref)}`
}

/** The reference behind a `driveRefHref` link, or null for any other link. */
export function driveRefOfHref(href: string): string | null {
  if (!href.startsWith("/drive?")) return null
  return new URLSearchParams(href.slice("/drive?".length)).get("ref")
}

/** Where the drive page shows what a reference resolved to: a folder itself, a file in its folder (highlighted). */
export function driveLocationOf(resolved: Pick<DriveResolveResponse, "kind" | "path" | "file">): string {
  if (resolved.kind === "folder" || !resolved.file) return driveHref(resolved.path)
  const folder = driveHref(resolved.file.parent_path)
  return `${folder}${folder.includes("?") ? "&" : "?"}file=${encodeURIComponent(resolved.file.id)}`
}

/** The few mdast fields the plugin reads and writes. */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/**
 * remark plugin: `drive:/…` references in a reply become links to the drive page, whether they are written in text, as
 * a link's target (`[q3](drive:/…)`, `<drive:/…>`, a link definition) or as a whole inline code span. Streamdown's
 * sanitizer drops `drive:` URLs, so the links point at the app's own drive page; the thread's link handler turns them
 * back into references for the host.
 */
export function remarkDriveRefs() {
  return (tree: MdNode) => {
    linkDriveRefs(tree)
  }
}

function linkDriveRefs(node: MdNode): void {
  if (!node.children) return
  const children: MdNode[] = []
  for (const child of node.children) {
    if (child.type === "link" || child.type === "definition") {
      if (child.url && isDriveRef(child.url)) child.url = driveRefHref(child.url)
      // Nothing inside a link becomes another link.
      children.push(child)
    } else if (child.type === "linkReference") {
      children.push(child)
    } else if (child.type === "inlineCode" && child.value && isDriveRef(child.value.trim())) {
      children.push({ type: "link", url: driveRefHref(child.value.trim()), children: [child] })
    } else if (child.type === "text" && child.value) {
      children.push(...splitText(child))
    } else {
      linkDriveRefs(child)
      children.push(child)
    }
  }
  node.children = children
}

function splitText(node: MdNode): MdNode[] {
  const text = node.value ?? ""
  const refs = findDriveRefs(text)
  if (!refs.length) return [node]
  const out: MdNode[] = []
  let at = 0
  for (const { start, end, ref } of refs) {
    if (start > at) out.push({ type: "text", value: text.slice(at, start) })
    out.push({ type: "link", url: driveRefHref(ref), children: [{ type: "text", value: ref }] })
    at = end
  }
  if (at < text.length) out.push({ type: "text", value: text.slice(at) })
  return out
}
