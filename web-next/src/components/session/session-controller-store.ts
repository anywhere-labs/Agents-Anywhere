import type { SessionController } from "./session-controller"
import type { SessionStateCache } from "./session-state-cache"

/** Only mounted views keep subscriptions; pending writes have a separate lifetime. */
export function createSessionControllerStore(cache: SessionStateCache) {
  type Entry = {
    controller: SessionController
    users: number
    token?: string
  }
  const entries = new Map<string, Entry>()
  const pendingSelections = new Map<string, SessionController["selectionChanges"]>()
  let active = true

  function evict(id: string, entry: Entry) {
    if (entries.get(id) !== entry) return
    entries.delete(id)
    entry.controller.dispose()
    const latest = entry.controller.getSnapshot()
    const cached = cache.get(id)
    if (latest.invalidated) cache.delete(id)
    else if (cached && latest.state) cache.set(id, { ...cached, state: latest.state, hasSnapshot: latest.hasSnapshot })
    const selections = entry.controller.selectionChanges
    if (selections.writes.size) {
      pendingSelections.set(id, selections)
      void Promise.allSettled([...selections.writes.values()]).then(() => {
        if (pendingSelections.get(id) === selections && selections.writes.size === 0) pendingSelections.delete(id)
      })
    }
  }

  function dispose() {
    for (const [id, entry] of entries) evict(id, entry)
    pendingSelections.clear()
  }

  return {
    get(id: string, create: () => SessionController, token?: string): SessionController {
      const existing = entries.get(id)
      if (existing && existing.token === token && !existing.controller.getSnapshot().invalidated) return existing.controller
      // Revocation and refreshed credentials require a new transport. Pending
      // selections remain in this account's store and transfer to its replacement.
      if (existing) evict(id, existing)
      const controller = create()
      const selections = pendingSelections.get(id)
      if (selections) {
        controller.selectionChanges = selections
        pendingSelections.delete(id)
      }
      entries.set(id, { controller, users: 0, token })
      return controller
    },
    retain(id: string, controller: SessionController, options: { start?: boolean } = {}) {
      const entry = entries.get(id)
      if (!entry || entry.controller !== controller) return () => {}
      entry.users++
      if (options.start !== false) controller.start()
      return () => {
        if (--entry.users > 0 || entries.get(id) !== entry) return
        // React's development effect replay retains the same view again in
        // this turn. A real departure closes at the end of effect cleanup.
        queueMicrotask(() => { if (entry.users === 0) evict(id, entry) })
      }
    },
    activate() {
      active = true
    },
    deactivate() {
      active = false
      queueMicrotask(() => {
        if (!active) dispose()
      })
    },
    dispose,
  }
}

export type SessionControllerStore = ReturnType<typeof createSessionControllerStore>
