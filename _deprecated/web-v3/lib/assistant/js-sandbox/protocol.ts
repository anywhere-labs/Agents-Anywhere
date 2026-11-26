// Experimental local JS execution for Pi Lite (docs/v3/assistant-and-files-proposal.md §7).
//
// Security red line: model-generated code NEVER runs as JavaScript of the app's origin — not on the page, and not
// as the script of a same-origin Worker. It is interpreted by QuickJS compiled to WASM; the Worker only hosts that
// interpreter. Inside QuickJS there is no DOM, no IndexedDB, no network and no access to the Worker's globals: the
// only way out is the bridge defined here (workspace VFS read/write/list, console capture, a JSON return value).

export interface SandboxLimits {
  /** Wall-clock budget for the whole run, enforced inside QuickJS (interrupt handler) and again by the host. */
  timeoutMs: number
  /** QuickJS heap limit. */
  memoryLimitBytes: number
  /** QuickJS stack limit (deep recursion fails instead of crashing the WASM instance). */
  maxStackBytes: number
  /** Total characters of console output kept; the rest is dropped and `logsTruncated` is set. */
  maxLogChars: number
  /** Characters of the JSON-serialized return value. */
  maxResultChars: number
  /** Number of workspace bridge calls one run may make. */
  maxVfsOps: number
  /** UTF-8 bytes of one file written through the bridge. */
  maxWriteBytes: number
  /** UTF-8 bytes written through the bridge in one run. */
  maxTotalWriteBytes: number
  /** Characters of one file returned by `vfs.read`. */
  maxReadChars: number
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
  maxLogChars: 64 * 1024,
  maxResultChars: 256 * 1024,
  maxVfsOps: 256,
  maxWriteBytes: 1024 * 1024,
  maxTotalWriteBytes: 8 * 1024 * 1024,
  maxReadChars: 2 * 1024 * 1024,
}

/** Hard upper bounds: a tool call may ask for less, never for more. */
export const MAX_SANDBOX_TIMEOUT_MS = 30_000

export function resolveSandboxLimits(overrides?: Partial<SandboxLimits>): SandboxLimits {
  const merged = { ...DEFAULT_SANDBOX_LIMITS }
  if (overrides) {
    for (const key of Object.keys(DEFAULT_SANDBOX_LIMITS) as (keyof SandboxLimits)[]) {
      const value = overrides[key]
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        merged[key] = Math.min(value, DEFAULT_SANDBOX_LIMITS[key])
      }
    }
    const timeout = overrides.timeoutMs
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
      merged.timeoutMs = Math.min(timeout, MAX_SANDBOX_TIMEOUT_MS)
    }
  }
  return merged
}

export type SandboxVfsOp = "read" | "write" | "list"

export type SandboxLogLevel = "log" | "info" | "warn" | "error" | "debug"

export interface SandboxLogEntry {
  level: SandboxLogLevel
  text: string
}

export type SandboxErrorKind = "timeout" | "memory" | "error" | "result" | "internal" | "aborted"

export interface SandboxRunResult {
  ok: boolean
  /** JSON value returned by the script (`undefined` when it returned nothing or failed). */
  value?: unknown
  error?: { kind: SandboxErrorKind; name: string; message: string }
  logs: SandboxLogEntry[]
  logsTruncated: boolean
  vfsOps: number
  durationMs: number
}

/** The bridge the sandbox can call. The host side is the only place that touches the real VFS. */
export type SandboxVfsCall = (op: SandboxVfsOp, args: unknown[]) => Promise<unknown>

// ── Host ⇄ Worker messages ──

export interface SandboxRunRequest {
  type: "run"
  code: string
  input?: unknown
  limits: SandboxLimits
}

export type HostToWorkerMessage =
  | SandboxRunRequest
  | { type: "vfs_result"; id: number; ok: true; value: unknown }
  | { type: "vfs_result"; id: number; ok: false; message: string }

export type WorkerToHostMessage =
  | { type: "ready" }
  | { type: "vfs"; id: number; op: SandboxVfsOp; args: unknown[] }
  | { type: "done"; result: SandboxRunResult }
