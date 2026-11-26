import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core"
import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { describe, expect, it } from "vitest"

import { runScriptInQuickJs } from "@/lib/assistant/js-sandbox/engine"
import {
  formatSandboxResult,
  runScriptInSandbox,
  type SandboxWorkerLike,
} from "@/lib/assistant/js-sandbox/host"
import {
  resolveSandboxLimits,
  type HostToWorkerMessage,
  type SandboxLimits,
  type SandboxVfsCall,
  type WorkerToHostMessage,
} from "@/lib/assistant/js-sandbox/protocol"
import {
  createWorkspaceBridge,
  resolveSandboxPath,
  type SandboxWorkspace,
} from "@/lib/assistant/js-sandbox/workspace-bridge"

// A fresh WASM instance per run, exactly like the one-run-per-Worker production setup.
const freshModule = (): Promise<QuickJSWASMModule> => newQuickJSWASMModuleFromVariant(variant)

function memoryWorkspace(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const calls: string[] = []
  const workspace: SandboxWorkspace = {
    async listFiles(prefix = "/workspace") {
      calls.push(`list:${prefix}`)
      return [...files.entries()].map(([path, text]) => ({ path, size: new TextEncoder().encode(text).byteLength }))
    },
    async readText(path) {
      calls.push(`read:${path}`)
      const text = files.get(path)
      if (text === undefined) throw new Error(`File not found in VFS: ${path}`)
      return text
    },
    async writeText(path, content) {
      calls.push(`write:${path}`)
      files.set(path, content)
      return { path, size: new TextEncoder().encode(content).byteLength }
    },
  }
  return { files, calls, workspace }
}

const noVfs: SandboxVfsCall = async () => {
  throw new Error("no vfs in this test")
}

async function run(code: string, opts: { limits?: Partial<SandboxLimits>; vfs?: SandboxVfsCall; input?: unknown } = {}) {
  return runScriptInQuickJs(await freshModule(), {
    code,
    input: opts.input,
    limits: resolveSandboxLimits(opts.limits),
    vfs: opts.vfs ?? noVfs,
  })
}

describe("QuickJS sandbox engine", () => {
  it("returns a JSON value and captures console output", async () => {
    const res = await run(`
      console.log("hello", { a: 1 }, [2, 3])
      console.warn("careful")
      console.error(new TypeError("boom"))
      return { sum: input.reduce((a, b) => a + b, 0), when: "now" }
    `, { input: [1, 2, 3] })
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ sum: 6, when: "now" })
    expect(res.logs).toEqual([
      { level: "log", text: 'hello {"a":1} [2,3]' },
      { level: "warn", text: "careful" },
      { level: "error", text: "TypeError: boom" },
    ])
  })

  it("reports thrown errors and syntax errors", async () => {
    const thrown = await run(`throw new RangeError("nope")`)
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toMatchObject({ kind: "error", name: "RangeError", message: "nope" })

    const syntax = await run(`return (`)
    expect(syntax.ok).toBe(false)
    expect(syntax.error?.name).toBe("SyntaxError")
  })

  it("interrupts a runaway synchronous loop at the timeout", async () => {
    const started = Date.now()
    const res = await run(`while (true) {}`, { limits: { timeoutMs: 300 } })
    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("times out a script that awaits forever", async () => {
    const res = await run(`await new Promise(() => {}); return 1`, { limits: { timeoutMs: 200 } })
    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe("timeout")
  })

  it("enforces the memory limit", async () => {
    const res = await run(
      `const chunks = []; while (true) chunks.push(new Array(100000).fill("xxxxxxxx"))`,
      { limits: { memoryLimitBytes: 8 * 1024 * 1024 } }
    )
    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe("memory")
  })

  it("stops deep recursion with a stack limit instead of crashing", async () => {
    const res = await run(`const f = (n) => f(n + 1) + 1; return f(0)`)
    expect(res.ok).toBe(false)
    expect(res.error?.message).toMatch(/stack/i)
  })

  it("has no network, storage, DOM, worker or module access", async () => {
    const res = await run(`
      const names = ["fetch", "XMLHttpRequest", "WebSocket", "indexedDB", "caches", "localStorage", "document",
        "window", "self", "navigator", "postMessage", "importScripts", "Worker", "location", "process", "require"]
      const seen = {}
      for (const n of names) seen[n] = typeof globalThis[n]
      let dynamicImport = "allowed"
      try { await import("https://example.com/x.js") } catch (e) { dynamicImport = "blocked" }
      return { seen, dynamicImport, hostFns: typeof hostVfs + typeof hostLog }
    `)
    expect(res.ok).toBe(true)
    const value = res.value as { seen: Record<string, string>; dynamicImport: string; hostFns: string }
    for (const [name, type] of Object.entries(value.seen)) expect([name, type]).toEqual([name, "undefined"])
    expect(value.dynamicImport).toBe("blocked")
    // The raw bridge functions are only reachable through the frozen `vfs` / `console` wrappers.
    expect(value.hostFns).toBe("undefinedundefined")
  })

  it("does not see the host's globalThis", async () => {
    ;(globalThis as Record<string, unknown>).__aaSecret = "e2ee-private-key"
    try {
      const res = await run(`return [typeof __aaSecret, Object.getOwnPropertyNames(globalThis).includes("__aaSecret")]`)
      expect(res.value).toEqual(["undefined", false])
    } finally {
      delete (globalThis as Record<string, unknown>).__aaSecret
    }
  })

  it("caps console output", async () => {
    const res = await run(`for (let i = 0; i < 1000; i++) console.log("x".repeat(100))`, {
      limits: { maxLogChars: 1_000 },
    })
    expect(res.ok).toBe(true)
    expect(res.logsTruncated).toBe(true)
    expect(res.logs.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(1_000)
  })

  it("rejects an oversized return value", async () => {
    const res = await run(`return "y".repeat(5000)`, { limits: { maxResultChars: 1_000 } })
    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe("result")
  })

  it("caps the number of workspace operations", async () => {
    const { workspace } = memoryWorkspace({ "/workspace/a.txt": "a" })
    const limits = resolveSandboxLimits({ maxVfsOps: 3 })
    const bridge = createWorkspaceBridge(workspace, limits)
    const res = await run(`for (let i = 0; i < 10; i++) await vfs.read("a.txt"); return "done"`, {
      limits: { maxVfsOps: 3 },
      vfs: bridge.call,
    })
    expect(res.ok).toBe(false)
    expect(res.error?.message).toMatch(/more than 3/)
    expect(res.vfsOps).toBe(4)
  })
})

describe("sandbox workspace bridge", () => {
  it("reads, writes and lists only inside /workspace", async () => {
    const { files, workspace } = memoryWorkspace({ "/workspace/data.csv": "a,b\n1,2\n3,4" })
    const bridge = createWorkspaceBridge(workspace, resolveSandboxLimits())
    const res = await run(`
      const csv = await vfs.read("data.csv")
      const rows = csv.split("\\n").slice(1).map((l) => l.split(",").map(Number))
      const saved = await vfs.write("/workspace/out/sum.json", JSON.stringify(rows.map(([a, b]) => a + b)))
      const listing = await vfs.list()
      return { saved, listing }
    `, { vfs: bridge.call })
    expect(res.ok).toBe(true)
    expect(files.get("/workspace/out/sum.json")).toBe("[3,7]")
    expect(res.value).toMatchObject({
      saved: { path: "/workspace/out/sum.json", size: 5 },
      listing: [
        { path: "/workspace/data.csv", size: 11 },
        { path: "/workspace/out/sum.json", size: 5 },
      ],
    })
    expect(bridge.written()).toEqual(["/workspace/out/sum.json"])
  })

  it("refuses paths outside the workspace and traversal", async () => {
    const { calls, workspace } = memoryWorkspace()
    const bridge = createWorkspaceBridge(workspace, resolveSandboxLimits())
    const res = await run(`
      const attempts = ["/etc/passwd", "../secret", "/workspace/../vault", "/workspaceX/a", "a/./b", "a\\u0000b", "/workspace", 42]
      const out = []
      for (const p of attempts) {
        try { await vfs.write(p, "x"); out.push("written:" + p) } catch (e) { out.push("refused") }
      }
      return out
    `, { vfs: bridge.call })
    expect(res.ok).toBe(true)
    expect(res.value).toEqual(Array(8).fill("refused"))
    expect(calls).toEqual([])
  })

  it("enforces per-file and per-run write budgets", async () => {
    const { workspace } = memoryWorkspace()
    const bridge = createWorkspaceBridge(workspace, resolveSandboxLimits({ maxWriteBytes: 10, maxTotalWriteBytes: 15 }))
    await expect(bridge.call("write", ["a.txt", "x".repeat(11)])).rejects.toThrow(/per file/)
    await expect(bridge.call("write", ["a.txt", "x".repeat(10)])).resolves.toMatchObject({ path: "/workspace/a.txt" })
    await expect(bridge.call("write", ["b.txt", "x".repeat(10)])).rejects.toThrow(/per run/)
    await expect(bridge.call("delete" as never, ["a.txt"])).rejects.toThrow(/unknown/)
  })

  it("normalizes paths without escaping the root", () => {
    expect(resolveSandboxPath("notes/a.md")).toBe("/workspace/notes/a.md")
    expect(resolveSandboxPath("/workspace//notes/a.md")).toBe("/workspace/notes/a.md")
    expect(resolveSandboxPath("/workspace", { allowRoot: true })).toBe("/workspace")
    expect(() => resolveSandboxPath("/tmp/a")).toThrow(/outside/)
    expect(() => resolveSandboxPath("a/../../b")).toThrow(/traversal/)
  })
})

describe("sandbox host", () => {
  /** An in-process stand-in for the Worker that runs the real engine and the real message protocol. */
  function engineWorker(): SandboxWorkerLike & { terminated: boolean } {
    const waiting = new Map<number, (msg: Extract<HostToWorkerMessage, { type: "vfs_result" }>) => void>()
    let nextId = 1
    const fake: SandboxWorkerLike & { terminated: boolean } = {
      terminated: false,
      onmessage: null,
      onerror: null,
      terminate() {
        this.terminated = true
      },
      postMessage(msg) {
        if (msg.type === "vfs_result") {
          waiting.get(msg.id)?.(msg)
          return
        }
        void (async () => {
          const result = await runScriptInQuickJs(await freshModule(), {
            code: msg.code,
            input: msg.input,
            limits: msg.limits,
            vfs: (op, args) =>
              new Promise((resolve, reject) => {
                const id = nextId++
                waiting.set(id, (r) => (r.ok ? resolve(r.value) : reject(new Error(r.message))))
                emit({ type: "vfs", id, op, args })
              }),
          })
          emit({ type: "done", result })
        })()
      },
    }
    const emit = (data: WorkerToHostMessage) => {
      if (!fake.terminated) fake.onmessage?.({ data } as MessageEvent<WorkerToHostMessage>)
    }
    return fake
  }

  it("runs through the message bridge and terminates the worker", async () => {
    const { files, workspace } = memoryWorkspace({ "/workspace/in.txt": "abc" })
    const worker = engineWorker()
    const outcome = await runScriptInSandbox({
      code: `const t = await vfs.read("in.txt"); await vfs.write("out.txt", t.toUpperCase()); console.log("ok"); return t.length`,
      workspace,
      createWorker: () => worker,
    })
    expect(outcome).toMatchObject({ ok: true, value: 3, written: ["/workspace/out.txt"] })
    expect(files.get("/workspace/out.txt")).toBe("ABC")
    expect(worker.terminated).toBe(true)
    expect(formatSandboxResult(outcome)).toContain("Files written: /workspace/out.txt")
  })

  it("kills a worker that never answers", async () => {
    let terminated = false
    const outcome = await runScriptInSandbox({
      code: "while (true) {}",
      limits: { timeoutMs: 50 },
      startupGraceMs: 50,
      workspace: memoryWorkspace().workspace,
      createWorker: () => ({
        onmessage: null,
        onerror: null,
        postMessage() {},
        terminate() {
          terminated = true
        },
      }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.kind).toBe("timeout")
    expect(terminated).toBe(true)
  })

  it("aborts on signal", async () => {
    const controller = new AbortController()
    let terminated = false
    const pending = runScriptInSandbox({
      code: "1",
      workspace: memoryWorkspace().workspace,
      signal: controller.signal,
      createWorker: () => ({
        onmessage: null,
        onerror: null,
        postMessage() {},
        terminate() {
          terminated = true
        },
      }),
    })
    controller.abort()
    const outcome = await pending
    expect(outcome.error?.kind).toBe("aborted")
    expect(terminated).toBe(true)
  })

  it("clamps requested limits to the defaults", () => {
    const limits = resolveSandboxLimits({ memoryLimitBytes: 10 * 1024 * 1024 * 1024, timeoutMs: 10 * 60_000, maxVfsOps: -1 })
    expect(limits.memoryLimitBytes).toBe(32 * 1024 * 1024)
    expect(limits.timeoutMs).toBe(30_000)
    expect(limits.maxVfsOps).toBe(256)
  })
})
