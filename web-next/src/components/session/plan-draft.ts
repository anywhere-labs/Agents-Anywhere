export type PlanStorage = {
  read: () => Promise<{ text: string | null; version: string; path: string }>
  write: (text: string, version: string) => Promise<string>
}

type PlanSnapshot = {
  text: string
  loaded: boolean
  status: "loading" | "unsaved" | "saving" | "saved" | "error"
  path: string
  error: string | null
}

export function createPlanDraft(text: string, storage?: PlanStorage) {
  let snapshot: PlanSnapshot = { text, loaded: !storage, status: storage ? "loading" : "unsaved", path: "", error: null }
  let version = ""
  let savedText: string | null = null
  let initialized: Promise<void> | undefined
  let saving: Promise<boolean> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<PlanSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const initialize = () => initialized ??= (async () => {
    if (!storage) return
    try {
      const file = await storage.read()
      version = file.version
      savedText = file.text
      publish({ loaded: true, text: file.text ?? snapshot.text, path: file.path, status: file.text === null ? "unsaved" : "saved", error: null })
    } catch (error) {
      initialized = undefined
      publish({ status: "error", error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  })()
  const flush = (): Promise<boolean> => {
    if (timer) clearTimeout(timer)
    if (saving) return saving
    saving = (async () => {
      if (!storage) return false
      try {
        await initialize()
        while (savedText !== snapshot.text) {
          const content = snapshot.text
          publish({ status: "saving", error: null })
          version = await storage.write(content, version)
          savedText = content
        }
        publish({ status: "saved", error: null })
        return true
      } catch (error) {
        publish({ status: "error", error: error instanceof Error ? error.message : String(error) })
        return false
      }
    })().finally(() => { saving = undefined })
    return saving
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    initialize: async () => { await initialize(); if (savedText === null && storage) await flush() },
    flush,
    update: ({ text }: { text: string }) => {
      if (text === snapshot.text) return
      publish({ text, status: "unsaved", error: null })
      if (timer) clearTimeout(timer)
      if (storage) timer = setTimeout(() => { void flush() }, 400)
    },
  }
}

export type PlanDraft = ReturnType<typeof createPlanDraft>
