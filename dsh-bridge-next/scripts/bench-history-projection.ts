/**
 * Measure the projection cost of one streamed assistant message.
 *
 * The projection is fed the same shape of events a live session produces:
 * many small text deltas, with `drain()` called once per flush window. The
 * benchmark reports the whole run so a change to hashing or item assembly is
 * visible immediately.
 *
 *   ./node_modules/.bin/tsx scripts/bench-history-projection.ts
 */
import { createProjection } from '../src/host/dsh-runtime/history.js'

const CHUNK_TEXT = 'x'

interface Options {
  chunks: number
  windowChunks: number
  chunkChars: number
}

function run({ chunks, windowChunks, chunkChars }: Options): number {
  const projection = createProjection('native', 'platform')
  const text = CHUNK_TEXT.repeat(chunkChars)
  const start = performance.now()
  projection.apply({ type: 'turn/start', data: { turn: 1 }, seq: 0, time: 0 } as never)
  projection.apply({ type: 'step/start', data: { turn: 1, step: 1 }, seq: 1, time: 1 } as never)
  let seq = 2
  for (let index = 0; index < chunks; index++) {
    projection.apply({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
      seq,
      time: seq,
    } as never)
    seq += 1
    if ((index + 1) % windowChunks === 0) projection.drain()
  }
  projection.apply({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq, time: seq } as never)
  projection.drain()
  return performance.now() - start
}

const chunks = Number(process.argv[2] ?? 9000)
const windowChunks = Number(process.argv[3] ?? 10)
const chunkChars = Number(process.argv[4] ?? 1)
const samples = Array.from({ length: 5 }, () =>
  run({ chunks, windowChunks, chunkChars })).sort((a, b) => a - b)
const best = samples[0]!
console.log(
  `chunks=${chunks} window_chunks=${windowChunks} windows=${Math.ceil(chunks / windowChunks)} ` +
  `payload=${chunks * chunkChars} bytes ` +
  `best=${best.toFixed(1)}ms median=${samples[Math.floor(samples.length / 2)]!.toFixed(1)}ms`,
)
