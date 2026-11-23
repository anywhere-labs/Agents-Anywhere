// Rows of the drive page (docs/v3/client-experience-proposal.md §2.6): one model for folders and files, what each
// row allows, and how sizes, times and expiries read. Framework-free so it can be tested.

import { intlLocale, type Locale } from "@/lib/i18n"
import { isOrchesPath, systemFolderOf } from "@/lib/drive/paths"
import type {
  DriveEntriesResponse,
  DriveFileView,
  DriveFolderView,
  DriveQuotaView,
  DriveSystemFolder,
} from "@/lib/types/v3"

export type DriveRow =
  | {
      kind: "folder"
      id: string
      path: string
      name: string
      ref: string
      system: DriveSystemFolder | null
      managed: boolean
      modifiedAt: string
      folder: DriveFolderView
    }
  | {
      kind: "file"
      id: string
      path: string
      name: string
      ref: string
      managed: boolean
      /** Content (and for some files the name) is end-to-end encrypted: the server cannot read it. */
      encrypted: boolean
      /** The server never learned a name: the file is named by its id. */
      nameHidden: boolean
      size: number
      modifiedAt: string
      expiresAt: string
      file: DriveFileView
    }

export function folderRow(folder: DriveFolderView): DriveRow {
  return {
    kind: "folder",
    id: folder.id,
    path: folder.path,
    name: folder.name,
    ref: folder.ref,
    system: folder.system ?? systemFolderOf(folder.path),
    managed: folder.managed,
    modifiedAt: folder.updated_at,
    folder,
  }
}

export function fileRow(file: DriveFileView): DriveRow {
  return {
    kind: "file",
    id: file.id,
    path: file.path,
    name: file.name,
    ref: file.ref,
    managed: file.managed,
    encrypted: file.encryption_mode !== "none",
    nameHidden: file.encryption_mode !== "none" && file.name === file.id,
    size: file.size_bytes,
    modifiedAt: file.completed_at ?? file.created_at,
    expiresAt: file.expires_at,
    file,
  }
}

/** Folders first (the server-created ones on top), then files; names in natural order ("2" before "10"). */
export function driveRows(listing: Pick<DriveEntriesResponse, "folders" | "files">, locale: Locale): DriveRow[] {
  const collator = new Intl.Collator(intlLocale(locale), { numeric: true, sensitivity: "base" })
  const byName = (a: DriveRow, b: DriveRow) => collator.compare(a.name, b.name) || a.name.localeCompare(b.name)
  const folders = listing.folders.map(folderRow).sort((a, b) => {
    const systemA = a.kind === "folder" && a.system ? 0 : 1
    const systemB = b.kind === "folder" && b.system ? 0 : 1
    return systemA - systemB || byName(a, b)
  })
  return [...folders, ...listing.files.map(fileRow).sort(byName)]
}

export interface DriveRowActions {
  open: boolean
  download: boolean
  rename: boolean
  move: boolean
  copyRef: boolean
  delete: boolean
}

/**
 * What a row allows. Server-created folders and anything in Orches' workspace cannot be renamed or moved; an
 * encrypted file keeps its name (it can move) and only the device or Orches it was meant for can open its bytes.
 */
export function driveRowActions(row: DriveRow): DriveRowActions {
  if (row.kind === "folder") {
    const fixed = row.system !== null || row.managed
    return { open: true, download: false, rename: !fixed, move: !fixed, copyRef: true, delete: true }
  }
  return {
    open: false,
    download: !row.encrypted,
    rename: !row.managed && !row.encrypted,
    move: !row.managed,
    copyRef: true,
    delete: true,
  }
}

/** New folders and uploads are possible here (everywhere but Orches' workspace). */
export function canWriteInto(folderPath: string): boolean {
  return !isOrchesPath(folderPath)
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/** "11月23日 14:03" / "Nov 23, 2:03 PM"; the year shows when it is not this year. */
export function formatDriveTime(iso: string | null | undefined, locale: Locale, now = Date.now()): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(t)
}

export interface DriveExpiry {
  /** "6天后" / "in 6 days"; empty when already past (the caller shows its own word). */
  label: string
  /** Full date and time, for a tooltip. */
  title: string
  /** Less than a day left. */
  soon: boolean
  expired: boolean
}

export function driveExpiry(iso: string, locale: Locale, now = Date.now()): DriveExpiry {
  const t = Date.parse(iso)
  const title = formatDriveTime(iso, locale, now)
  if (!Number.isFinite(t) || t <= now) return { label: "", title, soon: true, expired: true }
  const left = t - now
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" })
  const label =
    left >= DAY_MS
      ? rtf.format(Math.floor(left / DAY_MS), "day")
      : left >= HOUR_MS
        ? rtf.format(Math.floor(left / HOUR_MS), "hour")
        : rtf.format(Math.max(1, Math.floor(left / MINUTE_MS)), "minute")
  return { label, title, soon: left < DAY_MS, expired: false }
}

/** How long files are kept: "7 天" / "7 days", or hours / minutes when shorter than a day. */
export function formatDriveDuration(seconds: number, locale: Locale): string {
  const [value, unit] =
    seconds >= 86_400
      ? [Math.round(seconds / 86_400), "day"]
      : seconds >= 3_600
        ? [Math.round(seconds / 3_600), "hour"]
        : [Math.max(1, Math.round(seconds / 60)), "minute"]
  return new Intl.NumberFormat(intlLocale(locale), { style: "unit", unit, unitDisplay: "long" }).format(value)
}

export type DriveUploadPlan =
  | { ok: true }
  | { ok: false; reason: "disabled" | "empty" | "too_large" | "quota"; limit?: number }

/**
 * Whether a file can be uploaded with the account's limits, checked when the file is picked rather than after a
 * failed upload. `reserved` counts uploads already queued in this page.
 */
export function planDriveUpload(size: number, quota: DriveQuotaView | null, reserved = 0): DriveUploadPlan {
  if (!quota?.enabled) return { ok: false, reason: "disabled" }
  if (size <= 0) return { ok: false, reason: "empty" }
  if (quota.max_file_bytes != null && size > quota.max_file_bytes) {
    return { ok: false, reason: "too_large", limit: quota.max_file_bytes }
  }
  if (quota.remaining_bytes != null && size + reserved > quota.remaining_bytes) {
    return { ok: false, reason: "quota", limit: Math.max(0, quota.remaining_bytes - reserved) }
  }
  return { ok: true }
}
