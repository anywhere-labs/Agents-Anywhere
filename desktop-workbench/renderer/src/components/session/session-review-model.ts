import type { TimelineItem } from "@/features/dashboard/types"

export type FileChangeAction = "add" | "modify" | "delete" | "rename" | "unknown"
export type ReviewFileAction = "add" | "modify" | "delete"

export type ReviewFileChange = {
  path: string
  displayPath: string
  name: string
  action: ReviewFileAction
  diff: string
  additions: number
  deletions: number
  firstOrderSeq: number
  sourceItemIds: string[]
}

export type ChangedTurnReview = {
  key: string
  startOrderSeq: number
  files: ReviewFileChange[]
}

type MutableReviewFile = {
  path: string
  displayPath: string
  name: string
  action: ReviewFileAction
  diffs: string[]
  firstOrderSeq: number
  sourceItemIds: string[]
}

type MutableChangedTurn = {
  key: string
  startOrderSeq: number
  files: Map<string, MutableReviewFile>
}

type ExtractedFileChange = {
  path: string
  action: FileChangeAction
  diff: string
}

const CLAUDE_INTERRUPTED_REQUEST_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
])

export function buildLatestChangedTurnReview(
  items: TimelineItem[],
  options: { root?: string | null; caseInsensitivePaths?: boolean } = {},
): ChangedTurnReview | null {
  const root = options.root?.trim() || "."
  const caseInsensitivePaths = options.caseInsensitivePaths ?? false
  const orderedItems = latestTimelineItemRevisions(items)
  let currentTurn = mutableTurn("prelude", orderedItems[0]?.orderSeq ?? 0)
  let latestChangedTurn: MutableChangedTurn | null = null

  for (const item of orderedItems) {
    if (isVisibleUserTurnBoundary(item)) {
      if (currentTurn.files.size > 0) latestChangedTurn = currentTurn
      currentTurn = mutableTurn(textOf(item.source.clientMessageId) ?? item.id, item.orderSeq)
      continue
    }

    const changes = timelineItemFileChanges(item)
    if (changes.length === 0) continue
    for (const change of changes) {
      foldFileChange(currentTurn.files, change, item, root, caseInsensitivePaths)
    }
  }

  if (currentTurn.files.size > 0) latestChangedTurn = currentTurn
  return latestChangedTurn ? finishTurn(latestChangedTurn) : null
}

export function fileChangeAction(change: Record<string, unknown>): FileChangeAction {
  const direct = textOf(change.action) || textOf(change.type) || textOf(change.status)
  const nestedKind = isRecord(change.kind)
    ? textOf(change.kind.type)
    : textOf(change.kind)
  const value = (nestedKind || direct || "").toLowerCase()
  if (value === "add" || value === "added" || value === "create" || value === "created") return "add"
  if (value === "delete" || value === "deleted" || value === "remove" || value === "removed") return "delete"
  if (value === "rename" || value === "renamed" || value === "move" || value === "moved") return "rename"
  if (
    value === "modify"
    || value === "modified"
    || value === "change"
    || value === "changed"
    || value === "edit"
    || value === "edited"
    || value === "update"
    || value === "updated"
  ) return "modify"
  return "unknown"
}

export function fileChangeDisplayDiff(
  change: Record<string, unknown>,
  diff: string | null,
): string | null {
  if (!diff) return null
  if (isUnifiedDiffLike(diff)) return normalizeLineEndings(diff)
  const action = fileChangeAction(change)
  if (action === "add") return prefixRawDiff(diff, "+")
  if (action === "delete") return prefixRawDiff(diff, "-")
  return null
}

export function isCreatedFileChange(change: Record<string, unknown>) {
  return fileChangeAction(change) === "add"
}

export function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  const lines = normalizeLineEndings(diff).split("\n")
  if (lines.at(-1) === "") lines.pop()
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue
    if (line.startsWith("+")) additions += 1
    else if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

export function canonicalReviewPath(
  rawPath: string,
  root: string | null | undefined,
  caseInsensitivePaths = false,
): string {
  const normalizedPath = normalizePath(rawPath)
  const normalizedRoot = normalizePath(root?.trim() || ".")
  const resolved = pathIsAbsolute(normalizedPath) || normalizedRoot === "."
    ? normalizedPath
    : normalizePath(`${normalizedRoot}/${normalizedPath}`)
  return caseInsensitivePaths ? resolved.toLocaleLowerCase() : resolved
}

export function displayReviewPath(
  rawPath: string,
  root: string | null | undefined,
  caseInsensitivePaths = false,
): string {
  const normalizedRoot = normalizePath(root?.trim() || ".")
  const canonicalPath = canonicalReviewPath(rawPath, root, false)
  const comparablePath = caseInsensitivePaths ? canonicalPath.toLocaleLowerCase() : canonicalPath
  const comparableRoot = caseInsensitivePaths ? normalizedRoot.toLocaleLowerCase() : normalizedRoot
  if (comparableRoot !== "." && comparablePath === comparableRoot) return fileName(canonicalPath)
  const prefix = comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`
  if (comparableRoot !== "." && comparablePath.startsWith(prefix)) {
    return canonicalPath.slice(prefix.length) || fileName(canonicalPath)
  }
  return normalizePath(rawPath)
}

function isVisibleUserTurnBoundary(item: TimelineItem): boolean {
  if (item.type !== "message" || item.role !== "user") return false
  const itemType = textOf(item.source.itemType) ?? textOf(item.source.rawType)
  if (itemType === "steeringUserMessage") return false
  if (textOf(item.source.runtime) !== "claude") return true
  const message = firstTextOf(
    item.content.text,
    item.content.content,
    item.content.message,
    item.content.rawText,
  )?.trim()
  return !message || !CLAUDE_INTERRUPTED_REQUEST_MARKERS.has(message)
}

function latestTimelineItemRevisions(items: TimelineItem[]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>()
  for (const item of items) {
    const current = byId.get(item.id)
    if (!current || compareItemRevision(current, item) <= 0) byId.set(item.id, item)
  }
  return Array.from(byId.values()).sort(
    (left, right) => left.orderSeq - right.orderSeq
      || left.updatedSeq - right.updatedSeq
      || left.id.localeCompare(right.id),
  )
}

function compareItemRevision(left: TimelineItem, right: TimelineItem): number {
  return left.updatedSeq - right.updatedSeq
    || left.revision - right.revision
    || left.orderSeq - right.orderSeq
}

function timelineItemFileChanges(item: TimelineItem): ExtractedFileChange[] {
  if (textOf(item.content.kind) !== "file_change") return []
  const nested = rawFileChanges(item.content.changes)
    .map(normalizeExtractedFileChange)
    .filter((change): change is ExtractedFileChange => change !== null)
  if (nested.length > 0) return nested

  const direct = normalizeExtractedFileChange(item.content)
  return direct ? [direct] : []
}

function rawFileChanges(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([path, change]) => {
    if (!isRecord(change)) return []
    return [{ path, ...change }]
  })
}

function normalizeExtractedFileChange(change: Record<string, unknown>): ExtractedFileChange | null {
  const path = firstTextOf(change.path, change.filePath, change.file, change.uri)?.trim()
  if (!path) return null
  const rawDiff = firstTextOf(change.diff, change.patch, change.content)
  return {
    path,
    action: fileChangeAction(change),
    diff: fileChangeDisplayDiff(change, rawDiff) ?? normalizeLineEndings(rawDiff ?? ""),
  }
}

function foldFileChange(
  files: Map<string, MutableReviewFile>,
  change: ExtractedFileChange,
  item: TimelineItem,
  root: string,
  caseInsensitivePaths: boolean,
) {
  const path = canonicalReviewPath(change.path, root, false)
  const key = canonicalReviewPath(change.path, root, caseInsensitivePaths)
  const nextAction = reviewFileAction(change.action)
  const existing = files.get(key)

  if (existing?.action === "add" && nextAction === "delete") {
    files.delete(key)
    return
  }

  if (!existing) {
    const displayPath = displayReviewPath(change.path, root, caseInsensitivePaths)
    files.set(key, {
      path,
      displayPath,
      name: fileName(displayPath),
      action: nextAction,
      diffs: change.diff ? [change.diff] : [],
      firstOrderSeq: item.orderSeq,
      sourceItemIds: [item.id],
    })
    return
  }

  existing.action = foldedReviewAction(existing.action, nextAction)
  if (change.diff) existing.diffs.push(change.diff)
  if (!existing.sourceItemIds.includes(item.id)) existing.sourceItemIds.push(item.id)
}

function reviewFileAction(action: FileChangeAction): ReviewFileAction {
  if (action === "add" || action === "delete") return action
  return "modify"
}

function foldedReviewAction(current: ReviewFileAction, next: ReviewFileAction): ReviewFileAction {
  if (current === "add") return "add"
  if (current === "delete" && next === "add") return "modify"
  if (next === "delete") return "delete"
  return current
}

function mutableTurn(key: string, startOrderSeq: number): MutableChangedTurn {
  return { key, startOrderSeq, files: new Map() }
}

function finishTurn(turn: MutableChangedTurn): ChangedTurnReview {
  return {
    key: turn.key,
    startOrderSeq: turn.startOrderSeq,
    files: Array.from(turn.files.values())
      .sort((left, right) => left.firstOrderSeq - right.firstOrderSeq)
      .map((file) => {
        const diff = file.diffs.join("\n")
        const counts = diffLineCounts(diff)
        return {
          path: file.path,
          displayPath: file.displayPath,
          name: file.name,
          action: file.action,
          diff,
          additions: counts.additions,
          deletions: counts.deletions,
          firstOrderSeq: file.firstOrderSeq,
          sourceItemIds: file.sourceItemIds,
        }
      }),
  }
}

function isUnifiedDiffLike(value: string) {
  return normalizeLineEndings(value).split("\n").some((line) => {
    if (line.startsWith("@@")) return true
    if (line.startsWith("diff --git") || line.startsWith("index ")) return true
    if (line.startsWith("--- ") || line.startsWith("+++ ")) return true
    if (/^[+-]\S/.test(line)) return true
    return false
  })
}

function prefixRawDiff(value: string, prefix: "+" | "-") {
  const lines = normalizeLineEndings(value).split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.map((line) => `${prefix}${line}`).join("\n")
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n")
}

function normalizePath(value: string) {
  const raw = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/") || "."
  const drive = raw.match(/^([A-Za-z]:)(?:\/|$)/)?.[1] ?? ""
  const absolute = raw.startsWith("/")
  const home = raw === "~" || raw.startsWith("~/")
  const body = drive ? raw.slice(drive.length) : home ? raw.slice(1) : raw
  const parts: string[] = []
  for (const part of body.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop()
      else if (!absolute && !drive && !home) parts.push(part)
      continue
    }
    parts.push(part)
  }
  if (drive) return parts.length > 0 ? `${drive}/${parts.join("/")}` : `${drive}/`
  if (home) return parts.length > 0 ? `~/${parts.join("/")}` : "~"
  if (absolute) return parts.length > 0 ? `/${parts.join("/")}` : "/"
  return parts.join("/") || "."
}

function pathIsAbsolute(path: string) {
  return path.startsWith("/") || path.startsWith("~/") || path === "~" || /^[A-Za-z]:\//.test(path)
}

function fileName(path: string) {
  const normalized = normalizePath(path)
  return normalized.split("/").at(-1) || normalized
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function firstTextOf(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textOf(value)
    if (text) return text
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
