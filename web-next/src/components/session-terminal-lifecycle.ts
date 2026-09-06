import type { TerminalView } from "@/features/dashboard/types"
import type { SessionToolSidebarStore } from "./session-tool-sidebar-store.ts"
import type { SessionTerminalPreference } from "./session-terminal-preferences.ts"
import { createSessionToolTab } from "./session-tool-tabs.ts"
import { createClientId } from "../lib/id.ts"

type TerminalOperations = {
  list: () => Promise<TerminalView[]>
  create: (label: string) => Promise<TerminalView>
  close: (terminalId: string) => Promise<unknown>
}

type OpenTerminalOptions = {
  store: SessionToolSidebarStore
  sessionId: string
  userId: string
  connectorId: string
  root: string
  label: string
  operations: TerminalOperations
  restore?: SessionTerminalPreference
}

const opening = new WeakMap<SessionToolSidebarStore, Map<string, { pendingId: string; task: Promise<void> }>>()

export function openWorkspaceTerminal(options: OpenTerminalOptions): Promise<void> {
  const { store, sessionId, userId, connectorId, root, label, operations, restore } = options
  if (store.isShuttingDown()) return Promise.resolve()
  const contextMatches = () => {
    const context = store.getContext(sessionId)
    return !store.isShuttingDown() && context?.ownerUserId === userId
      && context.connectorId === connectorId && context.root === root
  }
  if (!contextMatches()) return Promise.resolve()

  const jobs = opening.get(store) ?? new Map<string, { pendingId: string; task: Promise<void> }>()
  opening.set(store, jobs)
  const key = JSON.stringify([sessionId, userId, connectorId, root])
  const existingJob = jobs.get(key)
  if (existingJob) {
    if (store.getState(sessionId).tabs.some((tab) => tab.id === existingJob.pendingId)) return existingJob.task
    return existingJob.task.catch(() => undefined).then(() => openWorkspaceTerminal(options))
  }

  const state = store.getState(sessionId)
  const hasTerminals = state.tabs.some((tab) => tab.terminal)
  if (restore && hasTerminals) return Promise.resolve()
  // A pending tab can also belong to a session whose optimistic ID just changed.
  if (state.tabs.some((tab) => tab.kind === "terminal" && !tab.terminal && !tab.error)) return Promise.resolve()
  for (const tab of state.tabs) {
    if (tab.kind === "terminal" && !tab.terminal) store.dispatch(sessionId, { type: "close-tab", id: tab.id })
  }

  const pendingId = createClientId("terminal_pending")
  const labels = new Set(store.getState(sessionId).tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.title))
  let title = label
  for (let index = 2; labels.has(title); index += 1) title = `${label} ${index}`
  const pending = createSessionToolTab(pendingId, "terminal", title)
  store.dispatch(sessionId, restore
    ? { type: "restore-terminal-layout", tab: pending, open: restore.open, expanded: restore.expanded, preferredWidth: restore.preferredWidth }
    : { type: "open-tool", tab: pending })
  const pendingExists = () => store.getState(sessionId).tabs.some((tab) => tab.id === pendingId)

  const task = Promise.resolve().then(async () => {
    if (!hasTerminals) {
      const listed = await operations.list()
      if (!contextMatches() || !pendingExists()) return
      const terminals = listed.filter((terminal) => terminal.root === root
        && !store.isTerminalClosed(connectorId, terminal.terminalId))
      if (terminals.length > 0 || restore) {
        store.dispatch(sessionId, {
          type: "restore-terminals", pendingId, terminals,
          activeTerminalId: restore?.activeTerminalId,
        })
        return
      }
    }
    if (!contextMatches() || !pendingExists()) return
    const terminal = await operations.create(title)
    // Leaving the page or account only detaches. The Connector continues to own
    // an already-created process, which a later inventory query can recover.
    if (!contextMatches()) return
    if (!pendingExists()) {
      // Explicitly closing a still-creating tab must not leave a new orphan shell.
      try {
        await operations.close(terminal.terminalId)
        store.removeTerminal(connectorId, terminal.terminalId)
      } catch (error) {
        if (contextMatches()) {
          store.dispatch(sessionId, { type: "open-tool", tab: pending })
          store.dispatch(sessionId, { type: "resolve-terminal", id: pendingId, terminal })
        }
        throw error
      }
      return
    }
    store.dispatch(sessionId, { type: "resolve-terminal", id: pendingId, terminal })
  }).catch((error: unknown) => {
    if (contextMatches() && pendingExists()) {
      store.dispatch(sessionId, {
        type: "fail-terminal", id: pendingId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }).finally(() => {
    if (jobs.get(key)?.task === task) jobs.delete(key)
  })
  jobs.set(key, { task, pendingId })
  return store.trackTerminalTask(task)
}
