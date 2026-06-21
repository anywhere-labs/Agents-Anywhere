"use client"

import * as React from "react"
import { ChevronRight, ChevronUp, File, Folder, FolderOpen, RefreshCw, X } from "lucide-react"

import "./runtime-panel.css"
import { ChevronExternal } from "./runtime-icons"
import { ScrollArea } from "@/components/ui/scroll-area"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export type PickedFile = {
  name: string
  path: string
}

type FilesPanelBodyProps = {
  token?: string | null
  connectorId?: string | null
  root?: string | null
  onClose?: () => void
  onPopOut?: () => void
  onPopupBlocked?: () => void
}

export function FilesPanelBody({
  token,
  connectorId,
  root,
  onClose,
  onPopOut,
  onPopupBlocked,
}: FilesPanelBodyProps) {
  const t = useTranslations("dashboard.panels.files")
  const effectiveRoot = root?.trim() || "."
  const [path, setPath] = React.useState(".")
  const [currentPath, setCurrentPath] = React.useState(".")
  const [entries, setEntries] = React.useState<FsEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canLoad = Boolean(token && connectorId)

  const loadDir = React.useCallback(
    async (nextPath: string) => {
      if (!token || !connectorId) return
      const target = nextPath.trim() || "."
      setLoading(true)
      setError(null)
      try {
        const response = await dashboardApi.connectorFsList(token, connectorId, {
          root: effectiveRoot,
          path: target,
        })
        const resolvedPath = response.result.path || target
        setEntries(response.result.entries)
        setCurrentPath(resolvedPath)
        setPath(resolvedPath)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [connectorId, effectiveRoot, token],
  )

  React.useEffect(() => {
    setPath(".")
    setCurrentPath(".")
    setEntries([])
    setError(null)
    if (canLoad) void loadDir(".")
  }, [canLoad, connectorId, effectiveRoot, loadDir])

  const parentPath = React.useMemo(() => parentOf(currentPath || path), [currentPath, path])
  const sortedEntries = React.useMemo(
    () =>
      entries.slice().sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1
        if (a.type !== "directory" && b.type === "directory") return 1
        return a.name.localeCompare(b.name)
      }),
    [entries],
  )

  const openEntry = (entry: FsEntry) => {
    if (entry.type === "directory") {
      void loadDir(entry.path)
      return
    }
    if (entry.type === "file" || entry.type === "symlink") {
      const file = { name: entry.name, path: entry.path }
      openNativeFilePreviewWindow({
        token,
        connectorId,
        root: effectiveRoot,
        file,
        onBlocked: onPopupBlocked,
        labels: {
          preview: t("preview"),
          loading: t("previewLoading", { name: file.name }),
          noConnector: t("noConnector"),
          binaryUnavailable: (size) => t("binaryUnavailable", { size }),
          truncated: t("truncated"),
        },
      })
    }
  }

  return (
    <div className="aa-rt-pane">
      <div className="aa-rt-hd">
        <div className="aa-rt-title">
          <FolderOpen className="size-3.5" />
          {t("title")}
        </div>
        <span className="aa-rt-sep" />
        <div className="aa-rt-acts">
          <button
            className="aa-rt-iconbtn"
            type="button"
            title={t("goParent")}
            onClick={() => parentPath && void loadDir(parentPath)}
            disabled={loading || !parentPath || !canLoad}
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            className="aa-rt-iconbtn"
            type="button"
            title={t("refresh")}
            onClick={() => void loadDir(path)}
            disabled={loading || !canLoad}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
          {onPopOut ? (
            <button className="aa-rt-iconbtn" type="button" title={t("openWindow")} onClick={onPopOut}>
              <ChevronExternal />
            </button>
          ) : null}
          {onClose ? (
            <button className="aa-rt-iconbtn" type="button" title={t("close")} onClick={onClose}>
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="aa-fs-pathbar">
        <div className="aa-fs-path-field">
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadDir(path)
            }}
            aria-label={t("directoryPath")}
            disabled={!canLoad}
          />
        </div>
        <button
          className="aa-rt-iconbtn"
          type="button"
          title={t("openPath")}
          onClick={() => void loadDir(path)}
          disabled={loading || !path.trim() || !canLoad}
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      <ScrollArea className="aa-fs-browser">
        <div className="aa-fs-browser-inner">
          {!canLoad ? <div className="aa-rt-empty">{t("noConnector")}</div> : null}
          {error ? <div className="aa-rt-error">{error}</div> : null}
          {loading && entries.length === 0 ? <div className="aa-rt-empty">{t("loading")}</div> : null}
          {!loading && !error && canLoad && entries.length === 0 ? <div className="aa-rt-empty">{t("empty")}</div> : null}
          {canLoad && parentPath ? (
            <button className="aa-fs-row" type="button" onClick={() => void loadDir(parentPath)}>
              <FolderOpen className="size-3.5" />
              <span>..</span>
              <em>{t("parent")}</em>
            </button>
          ) : null}
          {sortedEntries.map((entry) => (
            <button
              key={entry.path}
              className="aa-fs-row"
              type="button"
              onClick={() => openEntry(entry)}
              disabled={entry.type !== "directory" && entry.type !== "file" && entry.type !== "symlink"}
            >
              {entry.type === "directory" ? <Folder className="size-3.5" /> : <File className="size-3.5" />}
              <span>{entry.name}</span>
              <em>{entry.type === "file" && typeof entry.size === "number" ? formatBytes(entry.size) : entry.type}</em>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export function openNativeFilePreviewWindow({
  token,
  connectorId,
  root,
  file,
  onBlocked,
  labels,
}: {
  token?: string | null
  connectorId?: string | null
  root: string
  file: PickedFile
  onBlocked?: () => void
  labels?: {
    preview: string
    loading: string
    noConnector: string
    binaryUnavailable: (size: string) => string
    truncated: string
  }
}) {
  const previewLabels = labels ?? defaultPreviewLabels
  const child = window.open("", "_blank", "width=980,height=720,resizable=yes,scrollbars=yes")
  if (!child) {
    onBlocked?.()
    return
  }
  writePreviewDocument(child, {
    title: `${file.name} - ${previewLabels.preview}`,
    body: `<main class="center">${escapeHtml(previewLabels.loading)}</main>`,
  })
  if (!token || !connectorId) {
    writePreviewDocument(child, {
      title: `${file.name} - ${previewLabels.preview}`,
      body: `<main class="center error">${escapeHtml(previewLabels.noConnector)}</main>`,
    })
    return
  }
  dashboardApi
    .connectorFsReadText(token, connectorId, root, file.path, 1_000_000)
    .then((result) => {
      if (result.binary) {
        writePreviewDocument(child, {
          title: `${file.name} - ${previewLabels.preview}`,
          body: `<main class="center">${escapeHtml(previewLabels.binaryUnavailable(result.size.toLocaleString()))}</main>`,
        })
        return
      }
      writePreviewDocument(child, {
        title: `${file.name} - ${previewLabels.preview}`,
        body: buildCodePreviewBody(file, result.content, result.truncated, previewLabels.truncated),
      })
    })
    .catch((error) => {
      writePreviewDocument(child, {
        title: `${file.name} - ${previewLabels.preview}`,
        body: `<main class="center error">${escapeHtml(error instanceof Error ? error.message : String(error))}</main>`,
      })
    })
}

function writePreviewDocument(child: Window, { title, body }: { title: string; body: string }) {
  const theme = getPreviewTheme()
  child.document.open()
  child.document.write(`<!doctype html>
<html class="${escapeHtml(document.documentElement.className)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: ${theme.background}; color: ${theme.foreground}; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
    header { display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 14px; border-bottom: 1px solid ${theme.border}; background: ${theme.header}; font-family: ui-sans-serif, system-ui, sans-serif; }
    header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header span { color: ${theme.muted}; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scroll { overflow: auto; height: calc(100vh - 42px); padding: 8px 0; }
    .line { display: flex; min-height: 22px; }
    .line:hover { background: ${theme.hover}; }
    .ln { width: 52px; flex: 0 0 auto; padding-right: 12px; text-align: right; color: ${theme.lineNumber}; user-select: none; }
    .code { white-space: pre; padding: 0 16px 0 4px; }
    .center { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: ${theme.muted}; }
    .error { color: ${theme.error}; }
  </style>
</head>
<body>${body}</body>
</html>`)
  child.document.close()
  child.focus()
}

function getPreviewTheme() {
  const style = getComputedStyle(document.documentElement)
  const isDark = document.documentElement.classList.contains("dark")
  return {
    background: cssColor(style.getPropertyValue("--background"), isDark ? "#000000" : "#ffffff"),
    foreground: cssColor(style.getPropertyValue("--foreground"), isDark ? "#f4f4f5" : "#18181b"),
    header: cssColor(style.getPropertyValue("--sidebar"), isDark ? "#151515" : "#fafafa"),
    border: cssColor(style.getPropertyValue("--border"), isDark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.12)"),
    muted: cssColor(style.getPropertyValue("--muted-foreground"), isDark ? "#a1a1aa" : "#71717a"),
    error: cssColor(style.getPropertyValue("--destructive"), isDark ? "#f87171" : "#dc2626"),
    hover: isDark ? "rgba(255,255,255,.045)" : "rgba(0,0,0,.045)",
    lineNumber: isDark ? "#555" : "#a1a1aa",
  }
}

function cssColor(value: string, fallback: string) {
  return value.trim() || fallback
}

const defaultPreviewLabels = {
  preview: "Preview",
  loading: "Loading...",
  noConnector: "No online connector for this session.",
  binaryUnavailable: (size: string) => `Binary file (${size} bytes). Preview unavailable.`,
  truncated: "truncated",
}

function buildCodePreviewBody(file: PickedFile, content: string, truncated: boolean, truncatedLabel: string): string {
  const rows = content.split(/\r?\n/).map((line, index) => {
    const num = String(index + 1).padStart(4, " ")
    return `<div class="line"><span class="ln">${num}</span><span class="code">${escapeHtml(line)}</span></div>`
  }).join("")
  return `<header><strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(file.path)}${truncated ? ` · ${escapeHtml(truncatedLabel)}` : ""}</span></header><div class="scroll">${rows}</div>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function parentOf(rawPath: string): string {
  const clean = normalizeWindowsDrivePath(rawPath).trim().replace(/[/\\]+$/, "") || "."
  if (clean === "." || clean === "/" || /^[A-Za-z]:[\\/]?$/.test(clean)) return ""
  const normalized = clean.replace(/\\/g, "/")
  const slash = normalized.lastIndexOf("/")
  if (slash < 0) return "."
  if (slash === 0) return "/"
  return normalized.slice(0, slash)
}

function normalizeWindowsDrivePath(path: string): string {
  return path.replace(/^\/([A-Za-z]:[\\/])/, "$1")
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
