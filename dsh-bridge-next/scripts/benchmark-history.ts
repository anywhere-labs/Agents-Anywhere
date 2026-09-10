import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createProjection } from '../src/host/dsh-runtime/history.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

// Optional path permits an isolated checkout comparison with exactly the same input.
const project: typeof createProjection = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href)).createProjection : createProjection
const input = JSON.stringify({ command: 'x'.repeat(180_000) })
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  ...Array.from({ length: Math.ceil(input.length / 60) }, (_, index) => ({
    type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: {
      type: 'tool-call-delta', index: 0, id: 'call', name: 'bash', argumentsDelta: input.slice(index * 60, (index + 1) * 60),
    } },
  })),
].map((event, seq) => ({ ...event, seq, time: seq })) as SessionEvent[]
const durations: number[] = []
let parseCount = 0
for (let run = 0; run < 5; run++) {
  const parse = JSON.parse
  parseCount = 0
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parseCount++; return parse(...args) }) as typeof JSON.parse
  const start = performance.now()
  try {
    const projection = project('benchmark', 'platform')
    for (const event of events) projection.apply(event)
    const result = projection.snapshot()
    if (result.find(item => item.type === 'tool')?.content.command !== 'x'.repeat(180_000)) throw new Error('Incomplete output')
    durations.push(performance.now() - start)
  } finally { JSON.parse = parse }
}
durations.sort((a, b) => a - b)
console.log(JSON.stringify({ events: events.length, medianMs: Number(durations[2]!.toFixed(2)), jsonParses: parseCount }))
