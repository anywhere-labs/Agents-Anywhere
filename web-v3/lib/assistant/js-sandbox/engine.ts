// QuickJS-WASM execution engine for the experimental `js_run` tool. Runs inside the sandbox Worker (and directly in
// unit tests). The script is interpreted by QuickJS: it can only see the QuickJS standard library plus the
// `console`, `vfs` and `input` globals installed by the prelude below.

import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core"

import type {
  SandboxErrorKind,
  SandboxLimits,
  SandboxLogEntry,
  SandboxLogLevel,
  SandboxRunResult,
  SandboxVfsCall,
  SandboxVfsOp,
} from "@/lib/assistant/js-sandbox/protocol"

export interface RunScriptOptions {
  code: string
  input?: unknown
  limits: SandboxLimits
  vfs: SandboxVfsCall
}

const LOG_LEVELS = new Set<SandboxLogLevel>(["log", "info", "warn", "error", "debug"])
const VFS_OPS = new Set<SandboxVfsOp>(["read", "write", "list"])

// The prelude receives the host functions as arguments, so they never appear on the script's `globalThis`.
const PRELUDE = `(function (hostVfs, hostLog, inputJson) {
  "use strict";
  const fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message;
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  };
  const mk = (level) => (...args) => { hostLog(level, args.map(fmt).join(" ")); };
  globalThis.console = Object.freeze({
    log: mk("log"), info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug"),
  });
  const call = (op, args) => hostVfs(op, JSON.stringify(args)).then((s) => JSON.parse(s));
  globalThis.vfs = Object.freeze({
    read: (path) => call("read", [path]),
    write: (path, content) => call("write", [path, content]),
    list: (prefix) => call("list", prefix === undefined ? [] : [prefix]),
  });
  globalThis.input = inputJson === undefined ? undefined : JSON.parse(inputJson);
})`

function wrapUserCode(code: string): string {
  // The script is the body of an async function: `await vfs.read(...)` and `return value` both work.
  return `(async () => {\n${code}\n})().then((v) => (v === undefined ? undefined : JSON.stringify(v)))`
}

function classifyError(message: string): SandboxErrorKind {
  if (/interrupted/i.test(message)) return "timeout"
  if (/out of memory|memory limit|allocation failed/i.test(message)) return "memory"
  return "error"
}

function describeVmError(ctx: QuickJSContext, handle: QuickJSHandle): { kind: SandboxErrorKind; name: string; message: string } {
  let dumped: unknown
  try {
    dumped = ctx.dump(handle)
  } catch {
    dumped = undefined
  }
  let name = "Error"
  let message = "Script failed"
  if (dumped && typeof dumped === "object") {
    const d = dumped as { name?: unknown; message?: unknown }
    if (typeof d.name === "string") name = d.name
    if (typeof d.message === "string") message = d.message
  } else if (dumped === null) {
    // QuickJS throws `null` for an uncatchable exception such as running out of memory.
    message = "out of memory"
    name = "InternalError"
  } else if (dumped !== undefined) {
    message = String(dumped)
  }
  return { kind: classifyError(`${name} ${message}`), name, message }
}

export async function runScriptInQuickJs(
  module: QuickJSWASMModule,
  options: RunScriptOptions
): Promise<SandboxRunResult> {
  const { limits } = options
  const started = Date.now()
  const deadline = started + limits.timeoutMs
  const logs: SandboxLogEntry[] = []
  let logChars = 0
  let logsTruncated = false
  let vfsOps = 0
  let disposed = false
  const pending = new Set<QuickJSDeferredPromise>()

  const finish = (partial: Pick<SandboxRunResult, "ok" | "value" | "error">): SandboxRunResult => ({
    ...partial,
    logs,
    logsTruncated,
    vfsOps,
    durationMs: Date.now() - started,
  })

  const runtime = module.newRuntime()
  // Under Emscripten this only refuses a single allocation larger than the limit: QuickJS can't see allocation sizes
  // there. The instance's capped WASM memory (loadSandboxQuickJs) is what holds the heap to the limit.
  runtime.setMemoryLimit(limits.memoryLimitBytes)
  runtime.setMaxStackSize(limits.maxStackBytes)
  runtime.setInterruptHandler(() => Date.now() > deadline)
  // No module loader is installed: `import(...)` inside the script fails.
  const ctx = runtime.newContext()

  const pumpJobs = () => {
    if (disposed) return
    const res = runtime.executePendingJobs()
    if (res.error) res.error.dispose()
  }

  const hostLog = ctx.newFunction("hostLog", (levelH, textH) => {
    const level = ctx.typeof(levelH) === "string" ? (ctx.getString(levelH) as SandboxLogLevel) : "log"
    const text = ctx.typeof(textH) === "string" ? ctx.getString(textH) : ""
    if (logsTruncated) return
    const room = limits.maxLogChars - logChars
    if (text.length > room) {
      if (room > 0) logs.push({ level: LOG_LEVELS.has(level) ? level : "log", text: text.slice(0, room) })
      logChars = limits.maxLogChars
      logsTruncated = true
      return
    }
    logChars += text.length
    logs.push({ level: LOG_LEVELS.has(level) ? level : "log", text })
  })

  const hostVfs = ctx.newFunction("hostVfs", (opH, argsH) => {
    if (ctx.typeof(opH) !== "string" || ctx.typeof(argsH) !== "string") {
      throw new TypeError("vfs: invalid call")
    }
    const op = ctx.getString(opH) as SandboxVfsOp
    if (!VFS_OPS.has(op)) throw new TypeError(`vfs: unknown operation ${op}`)
    vfsOps++
    if (vfsOps > limits.maxVfsOps) {
      throw new RangeError(`vfs: more than ${limits.maxVfsOps} workspace operations in one run`)
    }
    const raw = ctx.getString(argsH)
    let args: unknown[]
    try {
      const parsed: unknown = JSON.parse(raw)
      args = Array.isArray(parsed) ? parsed : []
    } catch {
      throw new TypeError("vfs: arguments must be JSON-serializable")
    }
    const deferred = ctx.newPromise()
    pending.add(deferred)
    options.vfs(op, args).then(
      (value) => {
        if (disposed || !deferred.alive) return
        let json: string
        try {
          json = JSON.stringify(value ?? null)
        } catch {
          json = "null"
        }
        const h = ctx.newString(json)
        deferred.resolve(h)
        h.dispose()
      },
      (err: unknown) => {
        if (disposed || !deferred.alive) return
        const h = ctx.newError(err instanceof Error ? err.message : String(err))
        deferred.reject(h)
        h.dispose()
      }
    ).finally(() => {
      pending.delete(deferred)
      pumpJobs()
    })
    // The trampoline takes ownership of the returned handle; the deferred keeps its own resolvers.
    return deferred.handle
  })

  const teardown = () => {
    disposed = true
    for (const d of pending) {
      try {
        d.dispose()
      } catch {
        // already gone
      }
    }
    pending.clear()
    try {
      hostLog.dispose()
      hostVfs.dispose()
      ctx.dispose()
      runtime.dispose()
    } catch {
      // A run that hit its limits may leave the instance in a state QuickJS refuses to free cleanly; the Worker
      // hosting it is terminated right after, so nothing leaks past this run.
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // 1. Install the prelude (console / vfs / input).
    const preludeFn = ctx.evalCode(PRELUDE, "prelude.js")
    if (preludeFn.error) {
      const err = describeVmError(ctx, preludeFn.error)
      preludeFn.error.dispose()
      return finish({ ok: false, error: { ...err, kind: "internal" } })
    }
    let inputJson: string | undefined
    if (options.input !== undefined) {
      try {
        inputJson = JSON.stringify(options.input)
      } catch {
        preludeFn.value.dispose()
        return finish({ ok: false, error: { kind: "error", name: "TypeError", message: "input must be JSON-serializable" } })
      }
    }
    const inputH = inputJson === undefined ? ctx.undefined : ctx.newString(inputJson)
    const installed = ctx.callFunction(preludeFn.value, ctx.undefined, hostVfs, hostLog, inputH)
    preludeFn.value.dispose()
    if (inputH !== ctx.undefined) inputH.dispose()
    if (installed.error) {
      const err = describeVmError(ctx, installed.error)
      installed.error.dispose()
      return finish({ ok: false, error: { ...err, kind: "internal" } })
    }
    installed.value.dispose()

    // 2. Run the script.
    const evaluated = ctx.evalCode(wrapUserCode(options.code), "sandbox.js")
    if (evaluated.error) {
      const err = describeVmError(ctx, evaluated.error)
      evaluated.error.dispose()
      return finish({ ok: false, error: err })
    }
    const settled = ctx.resolvePromise(evaluated.value)
    evaluated.value.dispose()
    pumpJobs()

    const remaining = Math.max(0, deadline - Date.now())
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining + 25)
    })
    const outcome = await Promise.race([settled, timedOut])
    if (outcome === "timeout") {
      return finish({
        ok: false,
        error: { kind: "timeout", name: "TimeoutError", message: `Script did not finish within ${limits.timeoutMs} ms` },
      })
    }
    if (outcome.error) {
      const err = describeVmError(ctx, outcome.error)
      outcome.error.dispose()
      return finish({ ok: false, error: err })
    }
    const valueH = outcome.value
    const json = ctx.typeof(valueH) === "string" ? ctx.getString(valueH) : undefined
    valueH.dispose()
    if (json === undefined) return finish({ ok: true })
    if (json.length > limits.maxResultChars) {
      return finish({
        ok: false,
        error: {
          kind: "result",
          name: "RangeError",
          message: `Return value is ${json.length} characters; the limit is ${limits.maxResultChars}. Write large output to a workspace file instead.`,
        },
      })
    }
    return finish({ ok: true, value: JSON.parse(json) as unknown })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const kind = classifyError(message)
    return finish({ ok: false, error: { kind: kind === "error" ? "internal" : kind, name: "InternalError", message } })
  } finally {
    if (timer) clearTimeout(timer)
    teardown()
  }
}
