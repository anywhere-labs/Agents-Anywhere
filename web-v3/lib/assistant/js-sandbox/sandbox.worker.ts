/// <reference lib="webworker" />
// Dedicated Worker that hosts the QuickJS-WASM interpreter for one `js_run` call.
//
// This file is our own trusted code. The model's script never runs as this Worker's JavaScript: it is handed to
// QuickJS as a string and interpreted inside the WASM instance, which has no reference to this scope. As defence in
// depth, once QuickJS is loaded the Worker also removes its own network and storage entry points, so even an
// interpreter escape would find no `fetch`, `indexedDB`, `WebSocket`, `importScripts`, ... here.

import type { HostToWorkerMessage, SandboxRunResult, WorkerToHostMessage } from "@/lib/assistant/js-sandbox/protocol"

const scope = self as unknown as DedicatedWorkerGlobalScope

const LOCKED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebTransport",
  "EventSource",
  "indexedDB",
  "caches",
  "importScripts",
  "BroadcastChannel",
  "SharedWorker",
  "Worker",
  "FileSystemHandle",
  "FileSystemDirectoryHandle",
  "Request",
  "Response",
] as const

function lockDown(): void {
  for (const name of LOCKED_GLOBALS) {
    try {
      Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false })
    } catch {
      // Some engines refuse to shadow a few of these; the interpreter boundary is the real isolation.
    }
  }
  try {
    Object.defineProperty(scope.navigator, "storage", { value: undefined, configurable: false })
  } catch {
    // ignore
  }
}

function post(message: WorkerToHostMessage): void {
  scope.postMessage(message)
}

let nextId = 1
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let started = false

scope.addEventListener("message", (event: MessageEvent<HostToWorkerMessage>) => {
  const msg = event.data
  if (!msg || typeof msg !== "object") return
  if (msg.type === "vfs_result") {
    const entry = waiting.get(msg.id)
    if (!entry) return
    waiting.delete(msg.id)
    if (msg.ok) entry.resolve(msg.value)
    else entry.reject(new Error(msg.message))
    return
  }
  if (msg.type === "run") {
    if (started) return // one run per Worker: the host terminates it afterwards
    started = true
    void run(msg)
  }
})

async function run(msg: Extract<HostToWorkerMessage, { type: "run" }>): Promise<void> {
  let result: SandboxRunResult
  try {
    const [{ loadSandboxQuickJs }, { runScriptInQuickJs }] = await Promise.all([
      import("@/lib/assistant/js-sandbox/quickjs"),
      import("@/lib/assistant/js-sandbox/engine"),
    ])
    const quickjs = await loadSandboxQuickJs(msg.limits.memoryLimitBytes)
    lockDown()
    result = await runScriptInQuickJs(quickjs, {
      code: msg.code,
      input: msg.input,
      limits: msg.limits,
      vfs: (op, args) =>
        new Promise((resolve, reject) => {
          const id = nextId++
          waiting.set(id, { resolve, reject })
          post({ type: "vfs", id, op, args })
        }),
    })
  } catch (err) {
    result = {
      ok: false,
      error: { kind: "internal", name: "InternalError", message: err instanceof Error ? err.message : String(err) },
      logs: [],
      logsTruncated: false,
      vfsOps: 0,
      durationMs: 0,
    }
  }
  post({ type: "done", result })
}

post({ type: "ready" })
