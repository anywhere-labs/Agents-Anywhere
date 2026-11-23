import { describe, expect, it } from "vitest"

import { driveErrorMessage, driveFolderLabel } from "@/components/drive/drive-labels"
import { ControlApiError } from "@/lib/api/control-http"
import {
  canWriteInto,
  driveExpiry,
  driveRowActions,
  driveRows,
  fileRow,
  folderRow,
  formatDriveDuration,
  planDriveUpload,
} from "@/lib/drive/entries"
import {
  checkDriveName,
  cleanDriveName,
  driveBasename,
  driveBreadcrumbs,
  driveHref,
  driveJoin,
  driveParent,
  driveStemLength,
  isOrchesPath,
  isWithinDrivePath,
  normalizeDrivePath,
  systemFolderOf,
} from "@/lib/drive/paths"
import { messages, translate, type MessageKey, type Vars } from "@/lib/i18n"
import type { DriveFileView, DriveFolderView, DriveQuotaView } from "@/lib/types/v3"

const MiB = 1024 * 1024
const HOUR = 3_600_000
const DAY = 24 * HOUR

function folder(path: string, patch: Partial<DriveFolderView> = {}): DriveFolderView {
  const name = driveBasename(path)
  return {
    id: `fld_${name}`,
    path,
    name,
    parent_path: driveParent(path),
    ref: `drive:${path}`,
    system: systemFolderOf(path),
    managed: isOrchesPath(path),
    created_at: "2026-11-20T08:00:00Z",
    updated_at: "2026-11-20T08:00:00Z",
    ...patch,
  }
}

function file(path: string, patch: Partial<DriveFileView> = {}): DriveFileView {
  const name = driveBasename(path)
  return {
    id: `fil_${name}`,
    purpose: "transfer",
    status: "ready",
    size_bytes: 1024,
    sha256: "0".repeat(64),
    etag: null,
    filename: name,
    mime_type: null,
    vfs_path: null,
    path,
    name,
    parent_path: driveParent(path),
    ref: `drive:${path}`,
    managed: isOrchesPath(path),
    encryption_mode: "none",
    encryption_nonce: null,
    encryption_key_version: null,
    encrypted_meta: null,
    source_device_id: null,
    ttl_seconds: 7 * 86_400,
    created_at: "2026-11-20T08:00:00Z",
    completed_at: "2026-11-20T08:00:05Z",
    expires_at: "2026-11-30T08:00:00Z",
    ...patch,
  }
}

function quota(patch: Partial<DriveQuotaView> = {}): DriveQuotaView {
  return {
    enabled: true,
    rpc_direct_max_bytes: 8 * MiB,
    quota_bytes: 100 * MiB,
    used_bytes: 0,
    reserved_bytes: 0,
    remaining_bytes: 100 * MiB,
    max_file_bytes: 50 * MiB,
    default_ttl_seconds: 7 * 86_400,
    max_ttl_seconds: 30 * 86_400,
    file_count: 0,
    policy_source: "default",
    ...patch,
  }
}

const t = (key: MessageKey, vars?: Vars) => translate("en", key, vars)

describe("drive paths", () => {
  it("cleans a path from the address bar", () => {
    expect(normalizeDrivePath(null)).toBe("/")
    expect(normalizeDrivePath("")).toBe("/")
    expect(normalizeDrivePath("报告//2026/")).toBe("/报告/2026")
    expect(normalizeDrivePath("\\a\\b")).toBe("/a/b")
  })

  it("splits and joins paths", () => {
    expect(driveParent("/")).toBe("/")
    expect(driveParent("/a")).toBe("/")
    expect(driveParent("/a/b.txt")).toBe("/a")
    expect(driveBasename("/a/b.txt")).toBe("b.txt")
    expect(driveJoin("/", "a")).toBe("/a")
    expect(driveJoin("/a", "b")).toBe("/a/b")
    expect(driveBreadcrumbs("/")).toEqual([])
    expect(driveBreadcrumbs("/a/b")).toEqual([
      { path: "/a", name: "a" },
      { path: "/a/b", name: "b" },
    ])
  })

  it("matches subtrees by whole names", () => {
    expect(isWithinDrivePath("/a/b", "/a")).toBe(true)
    expect(isWithinDrivePath("/a", "/a")).toBe(true)
    expect(isWithinDrivePath("/ab", "/a")).toBe(false)
    expect(isWithinDrivePath("/anything", "/")).toBe(true)
    expect(isOrchesPath("/Orches")).toBe(true)
    expect(isOrchesPath("/Orches/workspace/notes.md")).toBe(true)
    expect(isOrchesPath("/OrchesBackup")).toBe(false)
    expect(systemFolderOf("/Transfers")).toBe("transfers")
    expect(systemFolderOf("/Orches")).toBe("orches")
    expect(systemFolderOf("/Transfers/x")).toBeNull()
  })

  it("checks typed names like the server does", () => {
    expect(checkDriveName("  ")).toBe("empty")
    expect(checkDriveName("a/b")).toBe("slash")
    expect(checkDriveName("a\\b")).toBe("slash")
    expect(checkDriveName("..")).toBe("dots")
    expect(checkDriveName("a\u0007b")).toBe("control")
    expect(checkDriveName("x".repeat(256))).toBe("too_long")
    expect(checkDriveName("😀".repeat(255))).toBeNull() // counted in code points, not UTF-16 units
    expect(checkDriveName("100% done (v2).txt")).toBeNull()
    expect(cleanDriveName("  Café ")).toBe("Café")
  })

  it("links folders with readable slashes", () => {
    expect(driveHref("/")).toBe("/drive")
    expect(driveHref("/报告/2026")).toBe(`/drive?path=/${encodeURIComponent("报告")}/2026`)
    expect(driveHref("/a b/c&d")).toBe("/drive?path=/a%20b/c%26d")
  })

  it("selects the stem when renaming", () => {
    expect(driveStemLength("q3.pdf")).toBe(2)
    expect(driveStemLength("backup.tar.gz")).toBe(6)
    expect(driveStemLength(".env")).toBe(4)
    expect(driveStemLength("README")).toBe(6)
  })
})

describe("drive rows", () => {
  it("lists system folders, then folders, then files, in natural order", () => {
    const rows = driveRows(
      {
        folders: [folder("/b"), folder("/Orches"), folder("/a10"), folder("/Transfers"), folder("/a2")],
        files: [file("/z.txt"), file("/file10.txt"), file("/File2.txt")],
      },
      "en"
    )
    expect(rows.map((row) => row.name)).toEqual([
      "Orches",
      "Transfers",
      "a2",
      "a10",
      "b",
      "File2.txt",
      "file10.txt",
      "z.txt",
    ])
  })

  it("only offers what the server allows", () => {
    expect(driveRowActions(folderRow(folder("/docs")))).toMatchObject({ rename: true, move: true, delete: true })
    expect(driveRowActions(folderRow(folder("/Transfers")))).toMatchObject({ rename: false, move: false, delete: true })
    expect(driveRowActions(folderRow(folder("/Orches/workspace")))).toMatchObject({ rename: false, move: false })

    expect(driveRowActions(fileRow(file("/a.txt")))).toMatchObject({ download: true, rename: true, move: true })
    const orches = fileRow(file("/Orches/workspace/a.md", { purpose: "assistant_vfs" }))
    expect(driveRowActions(orches)).toMatchObject({ download: true, rename: false, move: false, delete: true })

    const sealed = file("/Transfers/fil_x", { id: "fil_x", name: "fil_x", filename: null, encryption_mode: "ephemeral_key" })
    const row = fileRow(sealed)
    expect(row.kind === "file" && row.nameHidden).toBe(true)
    expect(driveRowActions(row)).toMatchObject({ download: false, rename: false, move: true, copyRef: true })

    expect(canWriteInto("/")).toBe(true)
    expect(canWriteInto("/Transfers")).toBe(true)
    expect(canWriteInto("/Orches/workspace")).toBe(false)
  })

  it("reads expiries relative to when the listing loaded", () => {
    const now = Date.parse("2026-11-23T08:00:00Z")
    const later = (ms: number) => new Date(now + ms).toISOString()
    expect(driveExpiry(later(6 * DAY + HOUR), "en", now)).toMatchObject({ label: "in 6 days", soon: false })
    expect(driveExpiry(later(3 * HOUR), "en", now)).toMatchObject({ label: "in 3 hours", soon: true })
    expect(driveExpiry(later(20_000), "en", now)).toMatchObject({ label: "in 1 minute", soon: true })
    expect(driveExpiry(later(-1), "en", now)).toMatchObject({ expired: true })
    expect(driveExpiry(later(2 * DAY), "zh-CN", now).label).toBe("后天")
  })

  it("says how long files are kept", () => {
    expect(formatDriveDuration(7 * 86_400, "en")).toBe("7 days")
    expect(formatDriveDuration(86_400, "en")).toBe("1 day")
    expect(formatDriveDuration(6 * 3_600, "en")).toBe("6 hours")
    expect(formatDriveDuration(7 * 86_400, "zh-CN")).toBe("7天")
  })
})

describe("drive uploads and errors", () => {
  it("checks a picked file against the account's limits", () => {
    expect(planDriveUpload(MiB, null)).toEqual({ ok: false, reason: "disabled" })
    expect(planDriveUpload(MiB, quota({ enabled: false }))).toEqual({ ok: false, reason: "disabled" })
    expect(planDriveUpload(0, quota())).toEqual({ ok: false, reason: "empty" })
    expect(planDriveUpload(60 * MiB, quota())).toEqual({ ok: false, reason: "too_large", limit: 50 * MiB })
    expect(planDriveUpload(40 * MiB, quota(), 70 * MiB)).toEqual({ ok: false, reason: "quota", limit: 30 * MiB })
    expect(planDriveUpload(40 * MiB, quota(), 10 * MiB)).toEqual({ ok: true })
    expect(planDriveUpload(40 * MiB, quota({ quota_bytes: null, remaining_bytes: null }), 500 * MiB)).toEqual({
      ok: true,
    })
  })

  it("names the server-created folders in the user's language", () => {
    expect(driveFolderLabel("/", "", t)).toBe("Cloud Drive")
    expect(driveFolderLabel("/Transfers", "Transfers", t)).toBe("Transfers")
    expect(driveFolderLabel("/Orches", "Orches", (key, vars) => translate("zh-CN", key, vars))).toBe("Orches")
    expect(driveFolderLabel("/Transfers", "Transfers", (key, vars) => translate("zh-CN", key, vars))).toBe("临时中转")
    expect(driveFolderLabel("/a/Transfers", "Transfers", t)).toBe("Transfers")
  })

  it("turns drive error codes into the user's words", () => {
    const conflict = new ControlApiError(409, "drive_path_conflict", "path /a.txt already exists")
    expect(driveErrorMessage(conflict, t, "a.txt")).toBe("“a.txt” already exists in this folder.")
    expect(driveErrorMessage(new ControlApiError(409, "drive_managed_path", "managed"), t)).toContain("Orches")
    expect(driveErrorMessage(new ControlApiError(500, "something_else", "boom"), t)).toBe("boom")
  })

  it("never calls Orches by an old name in the drive strings", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const strings = Object.entries(messages[locale]).filter(([key]) => key.startsWith("drive."))
      expect(strings.length).toBeGreaterThan(50)
      for (const [key, text] of strings) {
        expect(text, `${locale} ${key}`).not.toMatch(/随身助手|assistant/i)
      }
    }
  })
})
