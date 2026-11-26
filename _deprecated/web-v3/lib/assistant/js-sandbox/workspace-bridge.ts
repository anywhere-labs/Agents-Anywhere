// Host side of the sandbox ⇄ workspace bridge. This is the only code that touches the real assistant VFS on behalf
// of a script, so every path, size and operation is checked here (the sandbox side is never trusted).

import type { SandboxLimits, SandboxVfsCall } from "@/lib/assistant/js-sandbox/protocol"

/** The slice of `AssistantVfsManager` the bridge needs. */
export interface SandboxWorkspace {
  listFiles(prefix?: string): Promise<{ path: string; size: number }[]>
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<{ path: string; size: number }>
}

const WORKSPACE_ROOT = "/workspace"
const MAX_PATH_CHARS = 512

/**
 * Resolve a script-supplied path inside `/workspace`. Relative paths are taken from `/workspace`; absolute paths must
 * already be inside it. `.`/`..` segments, control characters and over-long paths are refused rather than rewritten,
 * so a script can never name anything outside the workspace.
 */
export function resolveSandboxPath(raw: unknown, { allowRoot = false } = {}): string {
  if (typeof raw !== "string") throw new TypeError("path must be a string")
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new TypeError("path contains control characters")
  const cleaned = raw.trim().replace(/\\/g, "/")
  if (cleaned.length === 0 || cleaned.length > MAX_PATH_CHARS) throw new RangeError("path is empty or too long")
  const parts = cleaned.split("/").filter(Boolean)
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error("path traversal ('.' or '..') is not allowed")
  }
  let resolved: string
  if (cleaned.startsWith("/")) {
    resolved = `/${parts.join("/")}`
    if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
      throw new Error(`path ${resolved} is outside ${WORKSPACE_ROOT}`)
    }
  } else {
    resolved = parts.length ? `${WORKSPACE_ROOT}/${parts.join("/")}` : WORKSPACE_ROOT
  }
  if (resolved === WORKSPACE_ROOT && !allowRoot) throw new Error(`${WORKSPACE_ROOT} is a directory, not a file`)
  return resolved
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export interface WorkspaceBridge {
  call: SandboxVfsCall
  /** Paths written during this run (for the tool result and the VFS panel refresh). */
  written: () => string[]
}

/** A bridge scoped to one run: its write budget starts at zero every time. */
export function createWorkspaceBridge(workspace: SandboxWorkspace, limits: SandboxLimits): WorkspaceBridge {
  let totalWritten = 0
  const written = new Set<string>()

  const call: SandboxVfsCall = async (op, args) => {
    switch (op) {
      case "list": {
        const prefix = args[0] === undefined ? WORKSPACE_ROOT : resolveSandboxPath(args[0], { allowRoot: true })
        const files = await workspace.listFiles(prefix)
        return files
          .filter((f) => f.path === prefix || f.path.startsWith(`${prefix.replace(/\/$/, "")}/`))
          .map((f) => ({ path: f.path, size: f.size }))
      }
      case "read": {
        const path = resolveSandboxPath(args[0])
        const text = await workspace.readText(path)
        if (text.length > limits.maxReadChars) {
          throw new RangeError(`${path} is larger than the ${limits.maxReadChars}-character read limit`)
        }
        return text
      }
      case "write": {
        const path = resolveSandboxPath(args[0])
        const content = args[1]
        if (typeof content !== "string") throw new TypeError("vfs.write content must be a string")
        const bytes = utf8Length(content)
        if (bytes > limits.maxWriteBytes) {
          throw new RangeError(`vfs.write is limited to ${limits.maxWriteBytes} bytes per file`)
        }
        if (totalWritten + bytes > limits.maxTotalWriteBytes) {
          throw new RangeError(`vfs.write is limited to ${limits.maxTotalWriteBytes} bytes per run`)
        }
        totalWritten += bytes
        const file = await workspace.writeText(path, content)
        written.add(file.path)
        return { path: file.path, size: file.size }
      }
      default:
        throw new TypeError(`unknown workspace operation ${String(op)}`)
    }
  }

  return { call, written: () => [...written] }
}
