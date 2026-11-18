import { useSyncExternalStore } from 'react'
import type { TimelineState, TimelineStore } from './store'

export function useTimeline(store: TimelineStore): TimelineState {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
