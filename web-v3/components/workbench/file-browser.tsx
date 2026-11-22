"use client"

// Files on a device (client-experience-proposal §2.3 文件 / §3.3 预览): a directory list and a file preview, read over
// the tunnel (Device/list_dirs, Device/read_file ≤ the RPC cap). Text and code are highlighted, Markdown rendered (with
// a source toggle), images and PDFs shown inline from the bytes; anything else gets a download. `layout="split"` puts
// list and preview side by side (device page), `"stack"` shows one at a time (the conversation's side panel). Reads
// are cached per device + path + mtime.
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Markdown } from "@/components/conversation/markdown"
import { languageOf } from "@/components/conversation/text"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "@/components/ui/code-block"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { DeviceRecord, ListDirsResult, ReadFileResult } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/workbench/time"
import { tildePath } from "@/lib/workbench/tree"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

const PREVIEW_MAX = 1024 * 1024
const BINARY_MAX = 8 * 1024 * 1024

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i
const PDF_EXT = /\.pdf$/i
const MD_EXT = /\.(md|markdown|mdx)$/i
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
}
const mimeOf = (path: string) => MIME_BY_EXT[(path.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream"

const LANG_EXTRA: Record<string, string> = {
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  toml: "toml",
  zsh: "bash",
  bash: "bash",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  vue: "vue",
  svelte: "svelte",
  php: "php",
  lua: "lua",
  dockerfile: "dockerfile",
}
export function languageForPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ""
  if (/^dockerfile$/i.test(base)) return "dockerfile"
  if (/^makefile$/i.test(base)) return "makefile"
  return languageOf(path) || LANG_EXTRA[(base.split(".").pop() ?? "").toLowerCase()] || "text"
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// device + path + mtime → read result (a few recent ones).
const readCache = new Map<string, ReadFileResult>()
function remember(key: string, value: ReadFileResult) {
  readCache.set(key, value)
  if (readCache.size > 40) readCache.delete(readCache.keys().next().value!)
}

function HighlightedText({ text, path }: { text: string; path: string }) {
  const lines = useHighlightedCode(text, languageForPath(path))
  return (
    <CodeBlock size="sm" className="rounded-2xl border-0 bg-background">
      <CodeBlockContent lineNumbers={false} className="text-xs">
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** One file's preview, read on demand. */
export function FilePreview({
  tunnelManager,
  device,
  path,
  className,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  path: string
  className?: string
}) {
  const { t } = useI18n()
  const [state, setState] = useState<{ path: string; result?: ReadFileResult; error?: string } | null>(null)
  const [showSource, setShowSource] = useState(false)
  const binaryKind = IMAGE_EXT.test(path) ? "image" : PDF_EXT.test(path) ? "pdf" : null
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!tunnelManager || !device) return
    let alive = true
    const key = `${device.id}:${path}`
    const cached = readCache.get(key)
    queueMicrotask(() => {
      if (alive) setState(cached ? { path, result: cached } : { path })
    })
    void tunnelManager
      .readFile(device, path, { maxBytes: binaryKind ? BINARY_MAX : PREVIEW_MAX })
      .then((result) => {
        remember(key, result)
        if (alive) setState({ path, result })
      })
      .catch((err) => {
        if (alive && !cached) setState({ path, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      alive = false
    }
  }, [binaryKind, device, nonce, path, tunnelManager])

  const result = state?.path === path ? state.result : undefined
  const error = state?.path === path ? state.error : undefined

  const blobUrl = useMemo(() => {
    if (!result || result.encoding !== "base64" || !binaryKind || !result.eof) return null
    return URL.createObjectURL(new Blob([base64ToBytes(result.content) as BlobPart], { type: mimeOf(path) }))
  }, [binaryKind, path, result])
  useEffect(() => () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }, [blobUrl])

  const download = useCallback(() => {
    if (!result) return
    const bytes =
      result.encoding === "base64" ? base64ToBytes(result.content) : new TextEncoder().encode(result.content)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) }))
    const a = document.createElement("a")
    a.href = url
    a.download = path.split(/[\\/]/).pop() || "file"
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }, [path, result])

  const name = path.split(/[\\/]/).pop() || path
  const isMarkdown = MD_EXT.test(path)

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={path}>
          {name}
        </span>
        {result && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatSize(result.size)}</span>}
        {isMarkdown && result?.encoding === "utf8" && (
          <Button variant="ghost" size="xs" onClick={() => setShowSource((v) => !v)}>
            {showSource ? t("panel.rendered") : t("panel.source")}
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" aria-label={t("common.refresh")} onClick={() => setNonce((n) => n + 1)}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
        {result && (
          <Button variant="ghost" size="icon-xs" aria-label={t("attach.download")} onClick={download}>
            <DownloadIcon className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="rounded-2xl bg-background p-4 text-xs text-destructive">{error}</p>
        ) : !result ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t("common.loading")}
          </div>
        ) : binaryKind === "image" && blobUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={blobUrl} alt={name} className="mx-auto max-h-[70vh] max-w-full rounded-2xl object-contain" />
        ) : binaryKind === "pdf" && blobUrl ? (
          <iframe src={blobUrl} title={name} className="h-[70vh] w-full rounded-2xl bg-background" />
        ) : result.encoding === "base64" ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-background p-8 text-center">
            <FileIcon className="size-7 stroke-[1.5] text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {binaryKind ? t("panel.truncated", { size: formatSize(result.bytes_read) }) : t("panel.binary")}
            </p>
            <Button variant="outline" size="sm" onClick={download}>
              <DownloadIcon className="size-3.5" />
              {t("attach.download")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {isMarkdown && !showSource ? (
              <div className="rounded-2xl bg-background px-5 py-4 text-sm">
                <Markdown>{result.content}</Markdown>
              </div>
            ) : (
              <HighlightedText text={result.content} path={path} />
            )}
            {!result.eof && (
              <p className="text-[11px] text-muted-foreground">
                {t("panel.truncated", { size: formatSize(result.bytes_read) })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** A directory list rooted anywhere on the device, with up / refresh, and a preview of the picked file. */
export function FileBrowser({
  tunnelManager,
  device,
  initialPath,
  openFile,
  layout = "split",
  className,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  initialPath?: string
  /** Open this file (a path the conversation pointed at); `nonce` reopens it after the user went back. */
  openFile?: { path: string; nonce: number } | null
  layout?: "split" | "stack"
  className?: string
}) {
  const { t } = useI18n()
  const [listing, setListing] = useState<ListDirsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [seenOpen, setSeenOpen] = useState<number | null>(null)
  if (openFile && openFile.nonce !== seenOpen) {
    setSeenOpen(openFile.nonce)
    setFile(openFile.path)
  }

  const load = useCallback(
    async (dir?: string) => {
      if (!tunnelManager || !device || device.presence !== "online") return
      setLoading(true)
      setError(null)
      try {
        const res = await tunnelManager.listDirs(device, dir || undefined)
        res.entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
        setListing(res)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [device, tunnelManager]
  )

  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (alive) void load(initialPath)
    })
    return () => {
      alive = false
    }
  }, [initialPath, load])

  if (!device || device.presence !== "online") {
    return <p className={cn("p-4 text-sm text-muted-foreground", className)}>{t("panel.offline")}</p>
  }

  const list = (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("newConv.up")}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={listing?.path}>
          {listing ? tildePath(listing.path) : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("common.refresh")}
          onClick={() => void load(listing?.path ?? initialPath)}
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing?.entries.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("panel.emptyDir")}</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                data-active={file === entry.path || undefined}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-full px-2.5 text-left text-[13px] hover:bg-surface-hover data-active:bg-surface-raised"
                onClick={() => (entry.is_dir ? void load(entry.path) : setFile(entry.path))}
              >
                {entry.is_dir ? (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : IMAGE_EXT.test(entry.name) ? (
                  <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {!entry.is_dir && (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatSize(entry.size)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )

  if (layout === "stack") {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        {file ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div>
              <Button variant="ghost" size="xs" onClick={() => setFile(null)}>
                <ArrowLeftIcon className="size-3.5" />
                {t("panel.back")}
              </Button>
            </div>
            <FilePreview tunnelManager={tunnelManager} device={device} path={file} className="flex-1" />
          </div>
        ) : (
          list
        )}
      </div>
    )
  }

  return (
    <div className={cn("grid min-h-0 gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]", className)}>
      <div className="flex max-h-[70vh] min-h-64 flex-col rounded-card bg-card p-3">{list}</div>
      <div className="min-h-64 min-w-0 rounded-card bg-card p-4">
        {file ? (
          <FilePreview tunnelManager={tunnelManager} device={device} path={file} className="h-full" />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("device.pickFile")}</p>
        )}
      </div>
    </div>
  )
}
