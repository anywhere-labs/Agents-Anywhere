// Drive paths on the client (docs/v3/assistant-and-files-proposal.md §6.1). The server normalizes and validates
// every path (server-v3 `core/drive.py`); these helpers build paths from names the user typed, pre-check names for
// a friendly message, and know the two server-created folders.

import type { DriveSystemFolder } from "@/lib/types/v3"

export const DRIVE_ROOT = "/"
export const TRANSFERS_FOLDER = "/Transfers"
export const ORCHES_FOLDER = "/Orches"
export const MAX_DRIVE_NAME_CHARS = 255

/** Light clean-up of a path from the address bar: `\` → `/`, empty segments dropped, leading `/`. */
export function normalizeDrivePath(raw: string | null | undefined): string {
  const parts = (raw ?? "").replace(/\\/g, "/").split("/").filter(Boolean)
  return `/${parts.join("/")}`
}

export function driveParent(path: string): string {
  if (path === DRIVE_ROOT) return DRIVE_ROOT
  const head = path.slice(0, path.lastIndexOf("/"))
  return head || DRIVE_ROOT
}

export function driveBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

export function driveJoin(parent: string, name: string): string {
  return parent === DRIVE_ROOT ? `/${name}` : `${parent}/${name}`
}

/** `path` is `ancestor` itself or lies below it. */
export function isWithinDrivePath(path: string, ancestor: string): boolean {
  return ancestor === DRIVE_ROOT || path === ancestor || path.startsWith(`${ancestor}/`)
}

/** Folders from the top down to `path` (root excluded): `/a/b` → `[{ "/a", "a" }, { "/a/b", "b" }]`. */
export function driveBreadcrumbs(path: string): { path: string; name: string }[] {
  const names = path.split("/").filter(Boolean)
  return names.map((name, index) => ({ path: `/${names.slice(0, index + 1).join("/")}`, name }))
}

export function systemFolderOf(path: string): DriveSystemFolder | null {
  if (path === TRANSFERS_FOLDER) return "transfers"
  if (path === ORCHES_FOLDER) return "orches"
  return null
}

/** Orches' cloud workspace: only Orches' own sync writes there. */
export function isOrchesPath(path: string): boolean {
  return path === ORCHES_FOLDER || path.startsWith(`${ORCHES_FOLDER}/`)
}

export type DriveNameProblem = "empty" | "slash" | "dots" | "control" | "too_long"

/** Why a typed file or folder name would be refused (same rules as the server), or null when it is fine. */
export function checkDriveName(raw: string): DriveNameProblem | null {
  const name = raw.normalize("NFC").trim()
  if (!name) return "empty"
  if (/[\\/]/.test(name)) return "slash"
  if (name === "." || name === "..") return "dots"
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "control"
  if (Array.from(name).length > MAX_DRIVE_NAME_CHARS) return "too_long"
  return null
}

/** The name as the server will store it (NFC, trimmed). */
export function cleanDriveName(raw: string): string {
  return raw.normalize("NFC").trim()
}

/** In-app link to a drive folder; slashes stay readable in the address bar. */
export function driveHref(path: string): string {
  const normalized = normalizeDrivePath(path)
  if (normalized === DRIVE_ROOT) return "/drive"
  return `/drive?path=${encodeURIComponent(normalized).replace(/%2F/g, "/")}`
}

/** A file's page: its folder plus `file=<id>`. */
export function driveFileHref(folder: string, fileId: string): string {
  const href = driveHref(folder)
  return `${href}${href.includes("?") ? "&" : "?"}file=${encodeURIComponent(fileId)}`
}

/** Where the extension starts, for selecting just the stem when renaming (`q3.pdf` → 2, `.env` → 4). */
export function driveStemLength(name: string): number {
  const lower = name.toLowerCase()
  for (const ext of [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"]) {
    if (lower.endsWith(ext) && name.length > ext.length) return name.length - ext.length
  }
  const dot = name.lastIndexOf(".")
  return dot > 0 ? dot : name.length
}
