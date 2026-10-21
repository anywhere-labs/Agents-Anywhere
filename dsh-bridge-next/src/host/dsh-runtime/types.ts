/** JSON shapes shared with contracts/dsh-bridge/1.0 and RuntimeTimelineItem. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Data = { [key: string]: Json }
export type ItemType = 'message' | 'tool' | 'system' | 'marker' | 'artifact' | 'turn.start' | 'turn.end'
export type ItemStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'hidden'
export interface TimelineItem {
  id: string
  sessionId: string
  type: ItemType
  status: ItemStatus
  orderSeq: number
  revision: number
  contentHash: string
  role: string | null
  turnId: string | null
  content: Data
  source: Data
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/** Normalize wire content without mutating native events or streaming buffers. */
export function wellFormedJson(value: Json): Json {
  if (typeof value === 'string') return wellFormedString(value)
  if (Array.isArray(value)) return value.map(wellFormedJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [wellFormedString(key), wellFormedJson(item)]))
  }
  return value
}

function wellFormedString(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}
