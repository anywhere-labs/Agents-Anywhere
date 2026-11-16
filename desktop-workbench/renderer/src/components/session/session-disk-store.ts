import type { CachedSessionState } from "./session-state-cache"

/**
 * One cached session on disk. The record version changes whenever the stored
 * shape does; older records are ignored and overwritten, never migrated.
 */
export type PersistedSessionRecord = {
  scope: string
  sessionId: string
  version: number
  accessedAt: number
  bytes: number
  value: CachedSessionState
}

export type PersistedSessionInfo = Pick<PersistedSessionRecord, "sessionId" | "accessedAt" | "bytes">

/** Durable storage behind the session cache. Every method is best-effort and never throws. */
export type PersistentSessionStore = {
  read(scope: string, sessionId: string): Promise<PersistedSessionRecord | null>
  write(record: PersistedSessionRecord): Promise<void>
  delete(scope: string, sessionId: string): Promise<void>
  list(scope: string): Promise<PersistedSessionInfo[]>
  /** Removes everything cached for one account/server. */
  clearScope(scope: string): Promise<void>
  /** Removes every account/server other than ``scope``; ``null`` removes all. */
  retainOnly(scope: string | null): Promise<void>
}

export const SESSION_DISK_RECORD_VERSION = 1

const DB_NAME = "agents-anywhere-session-cache"
const DB_VERSION = 1
const STORE = "sessions"
const SCOPE_INDEX = "scope"

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

/** IndexedDB-backed store; ``null`` where IndexedDB is unavailable (SSR, some private modes). */
export function createIndexedDbSessionStore(factory: IDBFactory | undefined = globalThis.indexedDB): PersistentSessionStore | null {
  if (!factory) return null
  let opening: Promise<IDBDatabase | null> | null = null
  const open = () => {
    opening ??= new Promise<IDBDatabase | null>((resolve) => {
      let req: IDBOpenDBRequest
      try {
        req = factory.open(DB_NAME, DB_VERSION)
      } catch {
        resolve(null)
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: ["scope", "sessionId"] })
          store.createIndex(SCOPE_INDEX, "scope")
        }
      }
      req.onsuccess = () => {
        const db = req.result
        // Another tab upgrading the schema must not be blocked by this one.
        db.onversionchange = () => { db.close(); opening = null }
        resolve(db)
      }
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    })
    return opening
  }
  async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => Promise<T> | T, fallback: T): Promise<T> {
    try {
      const db = await open()
      if (!db) return fallback
      const tx = db.transaction(STORE, mode)
      const result = await body(tx.objectStore(STORE))
      await transactionDone(tx)
      return result
    } catch {
      return fallback
    }
  }
  return {
    read: (scope, sessionId) =>
      run("readonly", async (store) => ((await request(store.get([scope, sessionId]))) as PersistedSessionRecord | undefined) ?? null, null),
    write: (record) => run("readwrite", (store) => { store.put(record) }, undefined),
    delete: (scope, sessionId) => run("readwrite", (store) => { store.delete([scope, sessionId]) }, undefined),
    list: (scope) =>
      run("readonly", async (store) => {
        const records = (await request(store.index(SCOPE_INDEX).getAll(scope))) as PersistedSessionRecord[]
        return records.map(({ sessionId, accessedAt, bytes }) => ({ sessionId, accessedAt, bytes }))
      }, []),
    clearScope: (scope) =>
      run("readwrite", async (store) => {
        const keys = await request(store.index(SCOPE_INDEX).getAllKeys(scope))
        for (const key of keys) store.delete(key)
      }, undefined),
    retainOnly: (scope) =>
      run("readwrite", async (store) => {
        if (scope === null) {
          store.clear()
          return
        }
        const keys = (await request(store.getAllKeys())) as [string, string][]
        for (const key of keys) if (key[0] !== scope) store.delete(key)
      }, undefined),
  }
}

/** A Map-backed store with the same semantics, for tests and environments without IndexedDB. */
export function createMemorySessionStore(): PersistentSessionStore & { records: Map<string, PersistedSessionRecord> } {
  const records = new Map<string, PersistedSessionRecord>()
  const key = (scope: string, sessionId: string) => JSON.stringify([scope, sessionId])
  return {
    records,
    async read(scope, sessionId) { return structuredClone(records.get(key(scope, sessionId)) ?? null) },
    async write(record) { records.set(key(record.scope, record.sessionId), structuredClone(record)) },
    async delete(scope, sessionId) { records.delete(key(scope, sessionId)) },
    async list(scope) {
      return [...records.values()].filter((record) => record.scope === scope)
        .map(({ sessionId, accessedAt, bytes }) => ({ sessionId, accessedAt, bytes }))
    },
    async clearScope(scope) { for (const [k, record] of records) if (record.scope === scope) records.delete(k) },
    async retainOnly(scope) { for (const [k, record] of records) if (scope === null || record.scope !== scope) records.delete(k) },
  }
}

const DISABLED_KEY = "agents-anywhere.session-cache.disabled"

/** Whether this browser may keep session content on disk ("不在此设备保存" turns it off). */
export function sessionDiskCacheAllowed(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(DISABLED_KEY) !== "1"
  } catch {
    return true
  }
}

export function setSessionDiskCacheAllowed(allowed: boolean, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage) {
  try {
    if (allowed) storage?.removeItem(DISABLED_KEY)
    else storage?.setItem(DISABLED_KEY, "1")
  } catch {
    // Without storage the preference cannot persist; the cache stays in memory.
  }
}

let sharedStore: PersistentSessionStore | null | undefined

// Forgetting a scope outlives the caches that were open at the time: a view
// closing after sign-out must not write its session back.
let forgottenAll = 0
const forgottenScopes = new Map<string, number>()

/** Changes whenever ``scope`` is forgotten; caches compare it before every write. */
export function sessionScopeEpoch(scope: string): string {
  return `${forgottenAll}:${forgottenScopes.get(scope) ?? 0}`
}

/** The browser's session store, or ``null`` when disk caching is unavailable or turned off. */
export function browserSessionStore(): PersistentSessionStore | null {
  if (typeof window === "undefined" || !sessionDiskCacheAllowed()) return null
  if (sharedStore === undefined) sharedStore = createIndexedDbSessionStore()
  return sharedStore
}

/** Deletes cached content regardless of the preference, e.g. on sign-out or when turning caching off. */
export function forgetSessionDiskCache(scope: string | null) {
  if (scope === null) forgottenAll++
  else forgottenScopes.set(scope, (forgottenScopes.get(scope) ?? 0) + 1)
  if (typeof window === "undefined") return Promise.resolve()
  sharedStore ??= createIndexedDbSessionStore()
  if (!sharedStore) return Promise.resolve()
  return scope === null ? sharedStore.retainOnly(null) : sharedStore.clearScope(scope)
}
