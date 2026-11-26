"use client"

// Small per-account workbench preferences kept in localStorage (they are UI memory, not secrets): pinned
// conversations (the Connector has no pin RPC yet, so pins live in this browser and are merged with
// `SessionSummary.pinned`), the last new-conversation choice (device → agent → directory), which devices are expanded
// in the sidebar, and whether the conversation's side panel is open.

import { useCallback, useSyncExternalStore } from "react"

export interface LastStart {
  deviceId: string
  agent?: string
  /** Per device: the last working directory used there. */
  cwdByDevice?: Record<string, string>
  /** Per device: the last agent used there. */
  agentByDevice?: Record<string, string>
}

export interface WorkbenchLocalPrefs {
  pins: string[]
  lastStart: LastStart | null
  panel: { open: boolean; tab: string }
}

const DEFAULTS: WorkbenchLocalPrefs = {
  pins: [],
  lastStart: null,
  panel: { open: false, tab: "files" },
}

const listeners = new Set<() => void>()
const cache = new Map<string, WorkbenchLocalPrefs>()

const storageKey = (accountId: string) => `aa-v3.workbench.${accountId}`

function read(accountId: string): WorkbenchLocalPrefs {
  const hit = cache.get(accountId)
  if (hit) return hit
  let value = DEFAULTS
  try {
    const raw = window.localStorage.getItem(storageKey(accountId))
    if (raw) {
      // `configByAgent` (options for new conversations, now remembered by the device) is dropped, not written back.
      const saved = JSON.parse(raw) as Partial<WorkbenchLocalPrefs> & { configByAgent?: unknown }
      delete saved.configByAgent
      value = { ...DEFAULTS, ...saved }
    }
  } catch {
    value = DEFAULTS
  }
  cache.set(accountId, value)
  return value
}

export function updateLocalPrefs(
  accountId: string,
  patch: Partial<WorkbenchLocalPrefs> | ((prev: WorkbenchLocalPrefs) => Partial<WorkbenchLocalPrefs>)
) {
  const prev = read(accountId)
  const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) }
  cache.set(accountId, next)
  try {
    window.localStorage.setItem(storageKey(accountId), JSON.stringify(next))
  } catch {
    // Private mode or quota: the in-memory copy still serves this tab.
  }
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("aa-v3.workbench.")) {
      cache.clear()
      listener()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** The account's local workbench preferences and a setter (no-ops until an account is known). */
export function useLocalPrefs(accountId: string | null | undefined) {
  const prefs = useSyncExternalStore(
    subscribe,
    () => (accountId ? read(accountId) : DEFAULTS),
    () => DEFAULTS
  )
  const update = useCallback(
    (patch: Partial<WorkbenchLocalPrefs> | ((prev: WorkbenchLocalPrefs) => Partial<WorkbenchLocalPrefs>)) => {
      if (accountId) updateLocalPrefs(accountId, patch)
    },
    [accountId]
  )
  return [prefs, update] as const
}

/** Toggle one entry of a string list (pins, expanded devices). */
export function toggleIn(list: string[], value: string, on?: boolean): string[] {
  const has = list.includes(value)
  const want = on ?? !has
  if (want === has) return list
  return want ? [...list, value] : list.filter((v) => v !== value)
}

/** Remember a started conversation's device, agent and directory for the next one. */
/** `cwd`: the directory used (null: the home directory, which is then the default again; undefined: unchanged). */
export function rememberStart(prev: LastStart | null, deviceId: string, agent: string, cwd?: string | null): LastStart {
  const dirs = { ...(prev?.cwdByDevice ?? {}) }
  if (cwd) dirs[deviceId] = cwd
  else if (cwd === null) delete dirs[deviceId]
  return {
    deviceId,
    agent,
    agentByDevice: { ...(prev?.agentByDevice ?? {}), [deviceId]: agent },
    cwdByDevice: dirs,
  }
}
