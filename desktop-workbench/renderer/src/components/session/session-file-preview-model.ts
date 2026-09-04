import type { SessionFilePreviewTarget } from "@/components/session/session-file-preview-context"
import type { FsEntry, FsListResult } from "@/features/dashboard/types"

export type SessionFileTargetMetadataResolution = {
  kind: "directory" | "file" | "unresolved"
  browsePath: string
  targetPath: string
  entry: FsEntry | null
}

export function sessionFileTreeAllowed(target: SessionFilePreviewTarget | null | undefined) {
  return target?.source !== "attachment"
}

export function sessionFileNameFromPath(path: string) {
  const normalized = normalizeFsPath(path)
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.split("/").pop() || path || "preview"
}

export function sessionFileParentPath(path: string) {
  const normalized = normalizeFsPath(path)
  if (normalized === "." || normalized === "~" || normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return ""
  }
  const slash = normalized.lastIndexOf("/")
  if (slash < 0) return "."
  if (slash === 0) return "/"
  if (slash === 2 && /^[A-Za-z]:\//.test(normalized)) return normalized.slice(0, 3)
  return normalized.slice(0, slash)
}

export function sessionFilePathNeedsCanonicalHome(path: string) {
  const normalized = path.trim().replaceAll("\\", "/")
  return normalized === "~" || normalized.startsWith("~/")
}

export function resolveSessionFileTargetMetadata(
  result: FsListResult,
  caseInsensitive = false,
): SessionFileTargetMetadataResolution | null {
  const targetPath = typeof result.targetPath === "string" ? result.targetPath.trim() : ""
  if (!targetPath && result.targetType !== "directory") return null

  if (result.targetType === "directory") {
    return {
      kind: "directory",
      browsePath: result.path,
      targetPath,
      entry: null,
    }
  }

  if (result.targetType === "file") {
    return {
      kind: "file",
      browsePath: result.path,
      targetPath,
      entry: result.entries.find((entry) => sameSessionFilePath(entry.path, targetPath, caseInsensitive)) ?? null,
    }
  }

  if (result.targetType === "missing" || result.targetType === "other") {
    return {
      kind: "unresolved",
      browsePath: result.path,
      targetPath,
      entry: null,
    }
  }

  return null
}

export function resolveSessionFilePath(
  root: string,
  path: string,
  windows = looksLikeWindowsPath(root),
  canonicalHome = "",
) {
  return windows
    ? resolveWindowsSessionFilePath(root, path, canonicalHome)
    : resolvePosixSessionFilePath(root, path, canonicalHome)
}

export function sessionFileListRepresentsDirectory(
  listedPath: string,
  root: string,
  targetPath: string,
  caseInsensitive = false,
  canonicalHome = "",
) {
  const normalizedTarget = normalizeFsPath(targetPath)
  if (normalizedTarget === "." || normalizedTarget === "~") return true
  const resolvedTarget = resolveSessionFilePath(
    root,
    targetPath,
    caseInsensitive || looksLikeWindowsPath(root),
    canonicalHome,
  )
  return sameSessionFilePath(listedPath, resolvedTarget, caseInsensitive)
}

export function findSessionFileTargetEntry(
  entries: FsEntry[],
  root: string,
  targetPath: string,
  caseInsensitive = false,
  canonicalHome = "",
) {
  const resolvedTarget = resolveSessionFilePath(
    root,
    targetPath,
    caseInsensitive || looksLikeWindowsPath(root),
    canonicalHome,
  )
  return entries.find((entry) => sameSessionFilePath(entry.path, resolvedTarget, caseInsensitive)) ?? null
}

export function sameSessionFilePath(left: string, right: string, caseInsensitive = false) {
  let normalizedLeft = normalizeFsPath(left)
  let normalizedRight = normalizeFsPath(right)
  if (caseInsensitive) {
    normalizedLeft = normalizedLeft.toLowerCase()
    normalizedRight = normalizedRight.toLowerCase()
  }
  if (normalizedLeft === normalizedRight) return true

  const unresolvedSuffix = normalizedRight.startsWith("~/")
    ? normalizedRight.slice(1)
    : isAbsoluteFsPath(normalizedRight) || normalizedRight === "." || normalizedRight === "~"
      ? null
      : `/${normalizedRight}`
  return Boolean(unresolvedSuffix && normalizedLeft.endsWith(unresolvedSuffix))
}

function isAbsoluteFsPath(path: string) {
  return path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:\//.test(path)
}

function resolvePosixSessionFilePath(root: string, path: string, canonicalHome: string) {
  const normalizedRoot = normalizePosixPath(cleanRemotePath(root))
  const cleanedPath = cleanRemotePath(path)
  if (sessionFilePathNeedsCanonicalHome(cleanedPath)) {
    return canonicalHome
      ? normalizePosixPath(`${normalizePosixPath(canonicalHome)}${cleanedPath.slice(1)}`)
      : cleanedPath
  }
  if (cleanedPath.startsWith("~")) return cleanedPath
  if (cleanedPath.startsWith("/")) return normalizePosixPath(cleanedPath)
  return normalizePosixPath(`${normalizedRoot}/${cleanedPath}`)
}

function resolveWindowsSessionFilePath(root: string, path: string, canonicalHome: string) {
  const normalizedRoot = normalizeFsPath(root)
  const rawPath = path.trim().replaceAll("\\", "/").replace(/^\/([A-Za-z]:\/)/, "$1") || "."
  if (sessionFilePathNeedsCanonicalHome(rawPath)) {
    return canonicalHome
      ? normalizeFsPath(`${normalizeFsPath(canonicalHome)}${rawPath.slice(1)}`)
      : normalizeFsPath(rawPath)
  }
  if (rawPath.startsWith("~") || rawPath.startsWith("//")) {
    return normalizeFsPath(rawPath)
  }

  const driveRelative = rawPath.match(/^([A-Za-z]:)(.*)$/)
  if (driveRelative) {
    const suffix = driveRelative[2] ?? ""
    if (suffix.startsWith("/")) return normalizeFsPath(`${driveRelative[1]}${suffix}`)
    return normalizeFsPath(`${normalizedRoot}/${suffix}`)
  }

  if (rawPath.startsWith("/")) {
    const rootPrefix = normalizedRoot.match(/^([A-Za-z]:)/)?.[1]
      ?? normalizedRoot.match(/^(\/\/[^/]+\/[^/]+)/)?.[1]
      ?? ""
    return normalizeFsPath(`${rootPrefix}${rawPath}`)
  }
  return normalizeFsPath(`${normalizedRoot}/${rawPath}`)
}

function looksLikeWindowsPath(path: string) {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\\\") || (path.includes("\\") && !path.startsWith("/"))
}

function normalizePosixPath(rawPath: string) {
  const value = rawPath.trim() || "."
  const isAbsolute = value.startsWith("/")
  const prefixLength = isAbsolute ? 1 : 0
  const resolved: string[] = []

  for (const segment of value.slice(prefixLength).split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (resolved.length > 0 && resolved.at(-1) !== "..") resolved.pop()
      else if (!isAbsolute) resolved.push(segment)
      continue
    }
    resolved.push(segment)
  }

  if (isAbsolute) return resolved.length > 0 ? `/${resolved.join("/")}` : "/"
  return resolved.join("/") || "."
}

function cleanRemotePath(path: string) {
  const value = path.trim().replace(/^\/([A-Za-z]:)/, "$1")
  return value || "."
}

function normalizeFsPath(rawPath: string) {
  let value = rawPath.trim().replaceAll("\\", "/")
  value = value.replace(/^\/([A-Za-z]:\/)/, "$1")
  if (!value) return "."

  const drive = value.match(/^([A-Za-z]:)(?:\/|$)/)?.[1] ?? null
  const isUnc = !drive && value.startsWith("//")
  const isAbsolute = !drive && !isUnc && value.startsWith("/")
  const isHome = !drive && !isUnc && (value === "~" || value.startsWith("~/"))
  const prefixLength = drive ? drive.length : isUnc ? 2 : isAbsolute ? 1 : isHome ? 1 : 0
  const segments = value.slice(prefixLength).split("/")
  const resolved: string[] = []

  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (resolved.length > 0 && resolved.at(-1) !== "..") resolved.pop()
      else if (!drive && !isUnc && !isAbsolute) resolved.push(segment)
      continue
    }
    resolved.push(segment)
  }

  if (drive) return resolved.length > 0 ? `${drive}/${resolved.join("/")}` : `${drive}/`
  if (isUnc) return resolved.length > 0 ? `//${resolved.join("/")}` : "//"
  if (isAbsolute) return resolved.length > 0 ? `/${resolved.join("/")}` : "/"
  if (isHome) return resolved.length > 0 ? `~/${resolved.join("/")}` : "~"
  return resolved.join("/") || "."
}
