// Page-side runner for the experimental `js_run` tool: one fresh dedicated Worker per run, terminated as soon as the
// run ends, times out or is aborted. The Worker only ever talks to the workspace bridge created here.

import {
  resolveSandboxLimits,
  type HostToWorkerMessage,
  type SandboxLimits,
  type SandboxRunResult,
  type WorkerToHostMessage,
} from "@/lib/assistant/js-sandbox/protocol"
import { createWorkspaceBridge, type SandboxWorkspace } from "@/lib/assistant/js-sandbox/workspace-bridge"

/** The part of `Worker` the runner uses (tests pass a fake). */
export interface SandboxWorkerLike {
  postMessage(message: HostToWorkerMessage): void
  terminate(): void
  onmessage: ((event: MessageEvent<WorkerToHostMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export interface RunSandboxOptions {
  code: string
  input?: unknown
  limits?: Partial<SandboxLimits>
  workspace: SandboxWorkspace
  signal?: AbortSignal
  /** Extra time on top of `timeoutMs` for loading QuickJS before the host kills the Worker outright. */
  startupGraceMs?: number
  createWorker?: () => SandboxWorkerLike
}

export interface SandboxRunOutcome extends SandboxRunResult {
  written: string[]
}

export function createSandboxWorker(): SandboxWorkerLike {
  return new Worker(new URL("./sandbox.worker.ts", import.meta.url), {
    type: "module",
    name: "aa-js-sandbox",
  }) as unknown as SandboxWorkerLike
}

export function isSandboxSupported(): boolean {
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined"
}

export function runScriptInSandbox(options: RunSandboxOptions): Promise<SandboxRunOutcome> {
  const limits = resolveSandboxLimits(options.limits)
  const bridge = createWorkspaceBridge(options.workspace, limits)
  const started = Date.now()

  return new Promise<SandboxRunOutcome>((resolve) => {
    let settled = false
    let worker: SandboxWorkerLike | null = null
    const timers: { kill?: ReturnType<typeof setTimeout> } = {}

    const failed = (kind: "timeout" | "aborted" | "internal", message: string): SandboxRunOutcome => ({
      ok: false,
      error: { kind, name: kind === "timeout" ? "TimeoutError" : kind === "aborted" ? "AbortError" : "InternalError", message },
      logs: [],
      logsTruncated: false,
      vfsOps: 0,
      durationMs: Date.now() - started,
      written: bridge.written(),
    })

    const settle = (outcome: SandboxRunOutcome) => {
      if (settled) return
      settled = true
      if (timers.kill) clearTimeout(timers.kill)
      options.signal?.removeEventListener("abort", onAbort)
      try {
        worker?.terminate()
      } catch {
        // already gone
      }
      worker = null
      resolve(outcome)
    }

    const onAbort = () => settle(failed("aborted", "The run was cancelled"))

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      worker = (options.createWorker ?? createSandboxWorker)()
    } catch (err) {
      settle(failed("internal", `Could not start the sandbox: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    // Backstop: QuickJS interrupts runaway code itself; if the Worker stops answering anyway, it is killed.
    timers.kill = setTimeout(
      () => settle(failed("timeout", `Script did not finish within ${limits.timeoutMs} ms; the sandbox was terminated`)),
      limits.timeoutMs + (options.startupGraceMs ?? 8_000)
    )

    worker.onerror = (event) => {
      event.preventDefault?.()
      settle(failed("internal", event.message || "The sandbox crashed"))
    }
    worker.onmessage = (event) => {
      const msg = event.data
      if (!msg || typeof msg !== "object" || settled) return
      if (msg.type === "vfs") {
        const id = msg.id
        bridge
          .call(msg.op, Array.isArray(msg.args) ? msg.args : [])
          .then(
            (value) => worker?.postMessage({ type: "vfs_result", id, ok: true, value }),
            (err: unknown) =>
              worker?.postMessage({
                type: "vfs_result",
                id,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
              })
          )
        return
      }
      if (msg.type === "done") {
        settle({ ...msg.result, written: bridge.written() })
      }
    }

    worker.postMessage({ type: "run", code: options.code, input: options.input, limits })
  })
}

/** Plain-text rendering of a run for the model. */
export function formatSandboxResult(outcome: SandboxRunOutcome): string {
  const lines: string[] = []
  if (outcome.ok) {
    lines.push(outcome.value === undefined ? "Script finished (no return value)." : `Result:\n${JSON.stringify(outcome.value, null, 2)}`)
  } else {
    lines.push(`Script failed (${outcome.error?.kind ?? "error"}): ${outcome.error?.name ?? "Error"}: ${outcome.error?.message ?? ""}`)
  }
  if (outcome.logs.length) {
    lines.push("Console:")
    for (const entry of outcome.logs) lines.push(`[${entry.level}] ${entry.text}`)
    if (outcome.logsTruncated) lines.push("(console output truncated)")
  }
  if (outcome.written.length) lines.push(`Files written: ${outcome.written.join(", ")}`)
  lines.push(`(${outcome.durationMs} ms, ${outcome.vfsOps} workspace operations)`)
  return lines.join("\n")
}
