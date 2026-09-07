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
