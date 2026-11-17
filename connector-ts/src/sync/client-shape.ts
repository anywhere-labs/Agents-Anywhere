import { createHash } from 'node:crypto'

import { eventCursor, toProtocolItem, type ProtocolTimelineItem, type TimelineItem } from '../domain/conversation/index.js'
import type { ChangesEvent, ProtocolEventEnvelope } from '../generated/device-meshcall/v1_0/changes-event.js'

/**
 * Client-shaped output (06-protocols.md §3.3): the device produces protocol 1.1/1.2 events itself, so the
 * Server only wraps and forwards them, and the same bytes can travel inside an E2EE tunnel unchanged.
 */
export const EVENT_PROTOCOL_VERSION = '1.1'

export function protocolEvent(sessionId: string, sequence: number, type: string, payload: Record<string, unknown>, emittedAt: string): ProtocolEventEnvelope {
  const hash = createHash('sha256').update(JSON.stringify([type, payload])).digest('hex').slice(0, 12)
  return {
    eventId: `evt_${sequence}_${hash}`,
    sequence,
    cursor: eventCursor(sequence),
    type,
    sessionId,
    emittedAt,
    payload,
    protocolVersion: EVENT_PROTOCOL_VERSION,
  }
}

/** Timeline events for items: revision 1 is `timeline.item_created`, later revisions `timeline.item_updated`. */
export function timelineEvents(sessionId: string, items: readonly TimelineItem[], emittedAt: string): ProtocolEventEnvelope[] {
  return [...items]
    .sort((left, right) => left.updatedSeq - right.updatedSeq)
    .map(item => protocolEvent(sessionId, item.updatedSeq, item.revision > 1 ? 'timeline.item_updated' : 'timeline.item_created', { item: toProtocolItem(item) }, emittedAt))
}

/** A replacement the client must apply as a whole (reset fence moved, or items were deleted). */
export function snapshotEvent(sessionId: string, headSeq: number, items: readonly TimelineItem[], hasMore: boolean, emittedAt: string): ProtocolEventEnvelope {
  return protocolEvent(sessionId, headSeq, 'timeline.snapshot', { items: items.map(toProtocolItem), hasMore }, emittedAt)
}

export function changesEvent(input: { sessionId: string; fromSeq: number; toSeq: number; resetSeq: number; events: ProtocolEventEnvelope[] }): ChangesEvent {
  return { sessionId: input.sessionId, fromSeq: input.fromSeq, toSeq: input.toSeq, resetSeq: input.resetSeq, events: input.events }
}

export function protocolItems(items: readonly TimelineItem[]): ProtocolTimelineItem[] {
  return items.map(toProtocolItem)
}

/**
 * Splits a JSON body into `StreamChunk` pieces of at most `maxBytes` UTF-8 bytes each (never inside a
 * character), so a snapshot larger than one MeshCall item still streams within the frame limit.
 */
export function chunkJson(body: unknown, maxBytes: number): { seq: number; chunk: string; end: boolean }[] {
  return chunkText(JSON.stringify(body), maxBytes)
}

/** `chunkJson` for JSON text already serialised (its size checked first, say). */
export function chunkText(text: string, maxBytes: number): { seq: number; chunk: string; end: boolean }[] {
  const chunks: { seq: number; chunk: string; end: boolean }[] = []
  let start = 0
  let seq = 0
  while (start < text.length || chunks.length === 0) {
    let end = Math.min(text.length, start + maxBytes)
    // Shrink until the slice fits in bytes; a UTF-16 surrogate pair is never split.
    while (end > start && Buffer.byteLength(text.slice(start, end), 'utf8') > maxBytes) end = start + Math.floor((end - start) * 0.9)
    if (end < text.length && end > start) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end--
    }
    if (end <= start) end = Math.min(text.length, start + 1)
    chunks.push({ seq: seq++, chunk: text.slice(start, end), end: end >= text.length })
    start = end
    if (start >= text.length) break
  }
  return chunks
}

export function joinChunks(chunks: readonly { chunk: unknown }[]): unknown {
  return JSON.parse(chunks.map(entry => String(entry.chunk)).join(''))
}
