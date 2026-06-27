"use client"

import * as React from "react"
import {
  Check,
  Copy,
  Download,
  Edit3,
  FileWarning,
  Loader2,
  RotateCw,
  Save,
  Search,
  X,
} from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { MonacoCodeView, type MonacoCodeViewApi } from "@/components/monaco-code-view"
import { dashboardApi } from "@/features/dashboard/api"
import { loadStoredSession } from "@/features/auth/session"
import type { FsReadTextResult } from "@/features/dashboard/types"

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "text"; file: FsReadTextResult }
  | { kind: "binary"; file: BinaryFileInfo; objectUrl: string | null }

type BinaryFileInfo = {
  path: string
  name: string
  size: number
  sha256: string
  mediaType: string
  downloadUrl: string
}

const TEXT_MAX_BYTES = 1_000_000

export function FilePreviewPage() {
  const t = useTranslations("preview")
  const params = useSearchParams()
  const connectorId = params.get("connectorId") ?? ""
  const root = params.get("root") ?? ""
  const path = params.get("path") ?? ""
  const name = params.get("name") || fileNameFromPath(path)
  const token = React.useMemo(() => loadStoredSession()?.accessToken ?? null, [])
  const [state, setState] = React.useState<PreviewState>({ kind: "loading" })
  const [editMode, setEditMode] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [downloadError, setDownloadError] = React.useState<string | null>(null)
  const [savedFlash, setSavedFlash] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const editorRef = React.useRef<MonacoCodeViewApi | null>(null)
  const editorInitialContentRef = React.useRef("")
  const objectUrlRef = React.useRef<string | null>(null)

  const canLoad = Boolean(token && connectorId && root && path)

  const revokeObjectUrl = React.useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = null
  }, [])

  const loadFile = React.useCallback(async () => {
    revokeObjectUrl()
    editorRef.current?.destroy()
    editorRef.current = null
    setState({ kind: "loading" })
    setDirty(false)
    setEditMode(false)
    setSaveError(null)
    setDownloadError(null)
    setSavedFlash(false)
    if (!canLoad || !token) {
      setState({ kind: "error", message: t("missingContext") })
      return
    }
    try {
      const text = await dashboardApi.connectorFsReadText(token, connectorId, root, path, TEXT_MAX_BYTES)
      if (!text.binary) {
        setState({ kind: "text", file: text })
        return
      }
      const response = await dashboardApi.connectorFsRead(token, connectorId, root, path)
      const mediaType = response.result.mediaType || mediaTypeForFile(response.result.name || name)
      const binary: BinaryFileInfo = {
        ...response.result,
        mediaType,
      }
      let objectUrl: string | null = null
      if (canBrowserPreview(mediaType, binary.name)) {
        const blob = await dashboardApi.downloadBlob(token, binary.downloadUrl)
        objectUrl = URL.createObjectURL(new Blob([blob], { type: mediaType || blob.type || "application/octet-stream" }))
        objectUrlRef.current = objectUrl
      }
      setState({ kind: "binary", file: binary, objectUrl })
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [canLoad, connectorId, name, path, revokeObjectUrl, root, t, token])

  React.useEffect(() => {
    void loadFile()
    return revokeObjectUrl
  }, [loadFile, revokeObjectUrl])

  React.useEffect(() => {
    if (state.kind === "loading" || state.kind === "error") return
    document.title = `${state.file.name || name} - ${t("title")}`
  }, [name, state, t])

  React.useEffect(() => {
    if (state.kind !== "text") return
    editorInitialContentRef.current = state.file.content
  }, [state])

  const handleEditorReady = React.useCallback((api: MonacoCodeViewApi) => {
    editorRef.current = api
  }, [])

  const handleEditorChange = React.useCallback(
    (value: string) => setDirty(value !== editorInitialContentRef.current),
    [],
  )

  const handleDownload = React.useCallback(async () => {
    setDownloadError(null)
    if (!token) return
    try {
      if (state.kind === "text") {
        const content = editorRef.current?.getValue() ?? state.file.content
        downloadBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), state.file.name || name)
        return
      }
      if (state.kind === "binary") {
        const blob = state.objectUrl
          ? await fetch(state.objectUrl).then((response) => response.blob())
          : await dashboardApi.downloadBlob(token, state.file.downloadUrl)
        downloadBlob(blob, state.file.name || name)
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err))
    }
  }, [name, state, token])

  const handleSave = React.useCallback(async () => {
    if (!token || state.kind !== "text" || !editorRef.current || !editMode) return
    const content = editorRef.current.getValue()
    setSaving(true)
    setSaveError(null)
    try {
      const response = await dashboardApi.connectorFsWrite(token, connectorId, root, {
        path,
        content,
        ifMatch: state.file.sha256,
      })
      setState((current) =>
        current.kind === "text"
          ? {
              kind: "text",
              file: {
                ...current.file,
                content,
                sha256: response.result.sha256,
                size: response.result.bytesWritten,
                truncated: false,
              },
            }
          : current,
      )
      setDirty(false)
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message.includes("412") ? t("saveConflict") : message)
    } finally {
      setSaving(false)
    }
  }, [connectorId, editMode, path, root, state, t, token])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void handleSave()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        if (editorRef.current) {
          event.preventDefault()
          editorRef.current.openSearch()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [handleSave])

  React.useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

  const copyText = React.useCallback(() => {
    if (state.kind !== "text") return
    const content = editorRef.current?.getValue() ?? state.file.content
    navigator.clipboard.writeText(content).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }, [state])

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-12 items-center gap-2 border-b bg-sidebar px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name || t("untitled")}</div>
          <div className="truncate code-mono text-xs text-muted-foreground">{path}</div>
        </div>
        <PreviewBadges state={state} dirty={dirty} saving={saving} savedFlash={savedFlash} saveError={saveError} />
        <Button variant="ghost" size="icon-sm" type="button" aria-label={t("refresh")} onClick={() => void loadFile()}>
          <RotateCw className="size-4" />
        </Button>
        <Button
          variant={editMode ? "secondary" : "ghost"}
          size="sm"
          type="button"
          disabled={state.kind !== "text"}
          onClick={() => {
            if (editMode) {
              if (dirty) {
                setSaveError(t("saveBeforeLeavingEdit"))
                return
              }
              setEditMode(false)
              return
            }
            setEditMode(true)
            window.setTimeout(() => editorRef.current?.focus(), 0)
          }}
        >
          <Edit3 className="size-3.5" />
          {t("edit")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t("search")}
          disabled={state.kind !== "text"}
          onClick={() => editorRef.current?.openSearch()}
        >
          <Search className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t("copy")}
          disabled={state.kind !== "text"}
          onClick={copyText}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t("download")}
          disabled={state.kind === "loading"}
          onClick={() => void handleDownload()}
        >
          <Download className="size-4" />
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={state.kind !== "text" || !dirty || saving || !editMode}
          onClick={() => void handleSave()}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {t("save")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t("close")}
          onClick={() => {
            if (dirty) {
              setSaveError(t("saveBeforeClose"))
              return
            }
            window.close()
          }}
        >
          <X className="size-4" />
        </Button>
      </header>
      {downloadError ? (
        <div className="border-b px-3 py-2 text-xs text-destructive">{downloadError}</div>
      ) : null}
      <section className="min-h-0 flex-1 overflow-hidden">
        {state.kind === "loading" ? <CenteredStatus label={t("loading")} /> : null}
        {state.kind === "error" ? (
          <div className="mx-auto flex h-full max-w-xl items-center px-6">
            <Alert variant="destructive">
              <FileWarning className="size-4" />
              <AlertTitle>{t("unavailable")}</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {state.kind === "text" ? (
          <MonacoCodeView
            key={`${state.file.path}:${state.file.sha256}:${editMode}`}
            fileName={state.file.name || name}
            content={state.file.content}
            editable={editMode}
            onReady={handleEditorReady}
            onChange={handleEditorChange}
            className="h-full min-h-0 overflow-hidden"
          />
        ) : null}
        {state.kind === "binary" ? (
          <BinaryPreview
            file={state.file}
            objectUrl={state.objectUrl}
            onDownload={() => void handleDownload()}
            downloading={false}
          />
        ) : null}
      </section>
    </main>
  )
}

function BinaryPreview({
  file,
  objectUrl,
  onDownload,
}: {
  file: BinaryFileInfo
  objectUrl: string | null
  onDownload: () => void
  downloading: boolean
}) {
  const t = useTranslations("preview")
  const kind = previewKind(file.mediaType, file.name)
  if (objectUrl && kind === "image") {
    return (
      <ScrollArea className="h-full bg-muted/20" contentWide>
        <div className="flex min-h-full min-w-full items-center justify-center p-4">
          <img src={objectUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    )
  }
  if (objectUrl && kind === "video") {
    return <div className="flex h-full items-center justify-center bg-black p-4"><video src={objectUrl} controls className="max-h-full max-w-full" /></div>
  }
  if (objectUrl && kind === "audio") {
    return <div className="flex h-full items-center justify-center p-8"><audio src={objectUrl} controls className="w-full max-w-2xl" /></div>
  }
  if (objectUrl && kind === "pdf") {
    return <iframe src={objectUrl} title={file.name} className="h-full w-full border-0" />
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <FileWarning className="size-10 text-muted-foreground" />
        <div>
          <div className="font-medium">{t("binaryUnavailable")}</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {file.mediaType || "application/octet-stream"} · {formatBytes(file.size)}
          </div>
        </div>
        <Button type="button" onClick={onDownload}>
          <Download className="size-4" />
          {t("download")}
        </Button>
      </div>
    </div>
  )
}

function PreviewBadges({
  state,
  dirty,
  saving,
  savedFlash,
  saveError,
}: {
  state: PreviewState
  dirty: boolean
  saving: boolean
  savedFlash: boolean
  saveError: string | null
}) {
  const t = useTranslations("preview")
  if (saveError) return <Badge variant="destructive" className="max-w-56 truncate">{saveError}</Badge>
  if (saving) return <Badge variant="secondary">{t("saving")}</Badge>
  if (dirty) return <Badge variant="secondary">{t("unsaved")}</Badge>
  if (savedFlash) return <Badge variant="secondary">{t("saved")}</Badge>
  if (state.kind === "text" && state.file.truncated) return <Badge variant="secondary">{t("truncated")}</Badge>
  return null
}

function CenteredStatus({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  )
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename || "download"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function canBrowserPreview(mediaType: string, name: string) {
  const kind = previewKind(mediaType, name)
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf"
}

function previewKind(mediaType: string, name: string): "image" | "video" | "audio" | "pdf" | "binary" {
  const type = mediaType.toLowerCase()
  const lowerName = name.toLowerCase()
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf"
  return "binary"
}

function mediaTypeForFile(name: string) {
  const lower = name.toLowerCase()
  if (/\.(png|apng|jpg|jpeg|gif|webp|avif|svg)$/.test(lower)) return `image/${lower.endsWith(".svg") ? "svg+xml" : lower.split(".").pop()}`
  if (/\.(mp4|webm|ogg|mov)$/.test(lower)) return lower.endsWith(".mov") ? "video/quicktime" : `video/${lower.split(".").pop()}`
  if (/\.(mp3|wav|oga|m4a|flac)$/.test(lower)) return `audio/${lower.split(".").pop()}`
  if (lower.endsWith(".pdf")) return "application/pdf"
  return "application/octet-stream"
}

function fileNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || path || "preview"
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
