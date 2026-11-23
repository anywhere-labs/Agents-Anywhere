// The QuickJS-WASM instance for one sandbox run (the sandbox Worker, and the unit tests).

import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from "quickjs-emscripten-core"

const PAGE_BYTES = 64 * 1024
/** The memory the QuickJS build declares and starts with; a smaller memory fails to link. */
const INITIAL_MEMORY_BYTES = 16 * 1024 * 1024
/** What the instance takes before a script allocates anything: its 5 MB C stack, static data, an empty runtime. */
const ENGINE_MEMORY_BYTES = 6 * 1024 * 1024

const pages = (bytes: number) => Math.ceil(bytes / PAGE_BYTES)

/**
 * A fresh QuickJS instance whose heap is held to about `memoryLimitBytes` (16 MB of memory at the least, which the
 * build needs to start). QuickJS can't see allocation sizes under Emscripten, so its own memory limit only refuses a
 * single allocation larger than the limit, and a script could otherwise grow the heap until the 32-bit address space
 * runs out. Capping the WebAssembly memory is what bounds it: past the cap `malloc` fails and the script gets
 * QuickJS's "out of memory" error. Memory never shrinks, so use one instance per run.
 */
export function loadSandboxQuickJs(memoryLimitBytes: number): Promise<QuickJSWASMModule> {
  const initial = pages(INITIAL_MEMORY_BYTES)
  const memory = new WebAssembly.Memory({
    initial,
    maximum: Math.max(initial, pages(ENGINE_MEMORY_BYTES + memoryLimitBytes)),
  })
  return newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }))
}
