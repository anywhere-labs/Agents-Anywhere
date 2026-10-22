/** CPU-only A/B benchmark; no server, credentials or stored sessions are used. */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

const repository = fileURLToPath(new URL("../../", import.meta.url))
const require = createRequire(import.meta.url)
const baseline = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length)
const client = process.argv.includes("--desktop") ? "desktop-workbench/renderer" : "web-next"

function loadModules(ref) {
  const cache = new Map()
  return function load(name) {
    if (cache.has(name)) return cache.get(name).exports
    const filename = `${client}/src/${name}.ts`
    const source = ref
      ? execFileSync("git", ["show", `${ref}:${filename}`], { cwd: repository, encoding: "utf8" })
      : readFileSync(path.join(repository, filename), "utf8")
    const module = { exports: {} }
    cache.set(name, module)
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    })
    // Evaluate the actual TS implementation, resolving its existing @/ imports
    // in memory. Compilation/module loading are outside the timed region.
    vm.runInThisContext(`(function(require,module,exports){${outputText}\n})`, { filename })(
      (specifier) => specifier.startsWith("@/") ? load(specifier.slice(2)) : require(specifier),
      module, module.exports,
    )
    return module.exports
  }
}

function item(index) {
  return {
    id: `item_${index}`, sessionId: "benchmark", type: "message", role: "assistant",
    status: "done", orderSeq: index + 1, updatedSeq: index + 1, revision: 1,
    contentHash: `hash_${index}`, content: { text: "x".repeat(11_000) },
    source: { runtime: "dsh", itemType: "message" },
  }
}

function medianMs(operation) {
  for (let index = 0; index < 3; index += 1) operation()
  const samples = []
  for (let index = 0; index < 15; index += 1) {
    const start = performance.now()
    operation()
    samples.push(performance.now() - start)
  }
  samples.sort((left, right) => left - right)
  return Number(samples[7].toFixed(4))
}

function run(ref) {
  const load = loadModules(ref)
  const { mergeTimelineItems } = load("components/session/optimistic-timeline")
  const review = load("components/session/session-review-model")
  const label = ref ?? "working-tree"
  for (const count of [569, 2000, 5000]) {
    const input = Array.from({ length: count }, (_, index) => ({
      ...item(index), role: index === 0 ? "user" : "assistant",
      status: index === count - 1 ? "running" : "done",
    }))
    let current = mergeTimelineItems([], input)
    let revision = count + 100
    const streamingMs = medianMs(() => {
      current = mergeTimelineItems(current, [{
        ...current.at(-1), updatedSeq: revision, revision: revision++,
      }])
    })
    const completion = { ...current.at(-1), status: "done", updatedSeq: revision, revision }
    console.log(JSON.stringify({ label, client, scenario: "dsh-single-turn", count, streamingMs,
      initialMergeMs: medianMs(() => mergeTimelineItems([], input)),
      completionMs: medianMs(() => mergeTimelineItems(current, [completion])),
    }))
  }

  const items = Array.from({ length: 569 }, (_, index) => index % 10 === 0
    ? { ...item(index), role: "user" }
    : { ...item(index), type: "tool", role: null, content: { kind: "file_change", changes: [{
      path: `/repo/f${index}.txt`, type: "update", diff: "@@ -1 +1 @@\n" + "+change line\n".repeat(900),
    }] } })
  items.push({ ...item(569), status: "running" })
  const select = review.createTurnReviewDisplaySelector?.() ?? review.buildTurnReviewDisplay
  const options = { root: "/repo", turnInProgress: true }
  const textUpdateMs = medianMs(() => {
    items[items.length - 1] = { ...items.at(-1), content: { text: "another token" } }
    select(items.slice(), options)
  })
  console.log(JSON.stringify({ label, client, scenario: "historical-file-review", count: items.length,
    textUpdateMs, rebuildMs: medianMs(() => review.buildTurnReviewDisplay(items, options)),
  }))
}

console.log("Synthetic CPU-only samples; medians of 15 operations after 3 warmups. Excludes React, DOM, network and JSON decoding.")
if (baseline) run(baseline)
run()
