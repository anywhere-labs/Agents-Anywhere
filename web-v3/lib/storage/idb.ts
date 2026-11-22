// Local browser vault persisted in IndexedDB (`aa-v3-vault`).
// Stores:
//   - browser-local client_id and X25519 static keypair (never shared across browsers)
//   - multi-account sessions (access/refresh tokens, serverUrl, authMode, user snapshot)
//   - pinned encrypted device trust records (`require_e2ee: true` is locally immutable)
//   - per-device offline session/project caches
//   - local assistant conversations (dual-fingerprint sync) & cached unlocked DEK
//   - OPFS fallback VFS blobs & UI preferences (including `assistantPrimary`)

import { generateE2EKey } from "meshcall/web"

import type {
  AuthMode,
  ClientDeviceTrustRecord,
  SessionListPayload,
  UserView,
} from "@/lib/types/v3"

const DB_NAME = "aa-v3-vault"
const DB_VERSION = 1

const STORES = [
  "meta",
  "account_sessions",
  "device_trust",
  "session_cache",
  "assistant_conversations",
  "assistant_keys",
  "assistant_vfs",
] as const

type StoreName = (typeof STORES)[number]

export interface ClientIdentityRecord {
  clientId: string
  privateKey: string
  publicKey: string
  createdAt: string
}

export interface StoredAccountSession {
  accountId: string
  serverUrl: string
  authMode: AuthMode
  accessToken: string
  refreshToken: string | null
  idToken?: string | null
  tokenEndpoint?: string | null
  oidcClientId?: string | null
  oidcIssuer?: string | null
  expiresAt: number
  user: UserView
  lastUsedAt: number
}

export interface CachedDeviceSessions {
  key: string
  accountId: string
  deviceId: string
  payload: SessionListPayload
  updatedAt: number
}

export interface LocalAssistantConversation {
  key: string
  accountId: string
  id: string
  title: string
  updatedAt: number
  hash: string
  syncedHash: string | null
  encrypted: boolean
  messages: Record<string, unknown>[]
  settings: Record<string, unknown> | null
}

export interface CachedAssistantDek {
  accountId: string
  dekB64: string
  keyVersion: number
  dekEpoch: number
  unlockedAt: string
}

export interface StoredVfsEntry {
  key: string
  accountId: string
  path: string
  contentBase64: string
  sha256: string
  size: number
  updatedAt: number
  syncedSha256: string | null
  driveFileId: string | null
  encrypted: boolean
}

export interface AssistantMcpServerConfig {
  id: string
  name: string
  url: string
  token?: string
  enabled: boolean
  isBuiltInAA?: boolean
  grantId?: string
}

export interface AssistantModelPref {
  source: "tokens" | "byok"
  format: "anthropic-messages" | "openai-completions" | "openai-responses"
  baseUrl: string
  model: string
  modelName?: string
  apiKey?: string
  thinking: "off" | "minimal" | "low" | "medium" | "high"
  webSearch: boolean
}

/**
 * Device credential the experimental controlled mode registered for this browser (`POST /devices/register`).
 * Kept so re-enabling reuses the same device row instead of using up another `max_devices` slot.
 */
export interface ControlledDeviceCredential {
  accountId: string
  deviceId: string
  deviceSecret: string
  name: string
  createdAt: number
}

/** Settings › Experimental (docs/v3/assistant-and-files-proposal.md §7). Everything here is off by default. */
export interface AssistantExperimentalPrefs {
  /** `js_run`: QuickJS-WASM sandbox with a confined workspace bridge. */
  jsExecution: boolean
  /** Register this tab's assistant as a temporary online instance (`aa.v3.Sessions`). */
  controlledMode: boolean
}

export const DEFAULT_EXPERIMENTAL_PREFS: AssistantExperimentalPrefs = {
  jsExecution: false,
  controlledMode: false,
}

export interface UserPreferences {
  assistantPrimary: boolean
  defaultServerUrl: string
  assistantModel?: AssistantModelPref | null
  assistantMcpServers: AssistantMcpServerConfig[]
  assistantExperimental: AssistantExperimentalPrefs
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  assistantPrimary: false,
  defaultServerUrl: "",
  assistantModel: null,
  assistantMcpServers: [],
  assistantExperimental: DEFAULT_EXPERIMENTAL_PREFS,
}

// ---------------------------------------------------------------------------
// Low-level IDB helper with automatic in-memory fallback (for SSR / non-IDB)
// ---------------------------------------------------------------------------

class VaultBackend {
  private dbPromise: Promise<IDBDatabase> | null = null
  private memory = new Map<StoreName, Map<string, unknown>>()

  constructor() {
    for (const s of STORES) this.memory.set(s, new Map())
  }

  private hasIndexedDb(): boolean {
    return typeof globalThis !== "undefined" && typeof globalThis.indexedDB !== "undefined"
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name)
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB vault"))
    })
    return this.dbPromise
  }

  async get<T>(store: StoreName, key: string): Promise<T | null> {
    if (!this.hasIndexedDb()) {
      return (this.memory.get(store)?.get(key) as T | undefined) ?? null
    }
    const db = await this.open()
    return new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(store, "readonly")
      const req = tx.objectStore(store).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error(`IDB get failed: ${store}/${key}`))
    })
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    if (!this.hasIndexedDb()) {
      this.memory.get(store)?.set(key, structuredClone(value))
      return
    }
    const db = await this.open()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite")
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error(`IDB put failed: ${store}/${key}`))
    })
  }

  async del(store: StoreName, key: string): Promise<void> {
    if (!this.hasIndexedDb()) {
      this.memory.get(store)?.delete(key)
      return
    }
    const db = await this.open()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite")
      tx.objectStore(store).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error(`IDB delete failed: ${store}/${key}`))
    })
  }

  async listAll<T>(store: StoreName): Promise<T[]> {
    if (!this.hasIndexedDb()) {
      return [...(this.memory.get(store)?.values() ?? [])].map((v) => structuredClone(v) as T)
    }
    const db = await this.open()
    return new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, "readonly")
      const req = tx.objectStore(store).getAll()
      req.onsuccess = () => resolve((req.result as T[]) ?? [])
      req.onerror = () => reject(req.error ?? new Error(`IDB getAll failed: ${store}`))
    })
  }

  async clearStore(store: StoreName): Promise<void> {
    if (!this.hasIndexedDb()) {
      this.memory.get(store)?.clear()
      return
    }
    const db = await this.open()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite")
      tx.objectStore(store).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error(`IDB clear failed: ${store}`))
    })
  }

  async resetConnection(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise.catch(() => null)
      db?.close()
      this.dbPromise = null
    }
    for (const s of STORES) this.memory.get(s)?.clear()
  }
}

const backend = new VaultBackend()

function randomClientId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `cli_web_${hex}`
}

export const vault = {
  // ── Browser-local installation identity & X25519 static keypair ──

  async getOrCreateClientIdentity(): Promise<ClientIdentityRecord> {
    const existing = await backend.get<ClientIdentityRecord>("meta", "client_identity")
    if (existing?.clientId && existing.privateKey && existing.publicKey) {
      return existing
    }
    const pair = await generateE2EKey()
    const created: ClientIdentityRecord = {
      clientId: randomClientId(),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      createdAt: new Date().toISOString(),
    }
    await backend.put("meta", "client_identity", created)
    return created
  },

  async regenerateClientIdentity(): Promise<ClientIdentityRecord> {
    const pair = await generateE2EKey()
    const created: ClientIdentityRecord = {
      clientId: randomClientId(),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      createdAt: new Date().toISOString(),
    }
    await backend.put("meta", "client_identity", created)
    await backend.clearStore("device_trust")
    return created
  },

  // ── Multi-account sessions ──

  async listAccounts(): Promise<StoredAccountSession[]> {
    const all = await backend.listAll<StoredAccountSession>("account_sessions")
    return all.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  },

  async getActiveAccountId(): Promise<string | null> {
    return backend.get<string>("meta", "active_account_id")
  },

  async setActiveAccountId(accountId: string | null): Promise<void> {
    if (accountId === null) await backend.del("meta", "active_account_id")
    else await backend.put("meta", "active_account_id", accountId)
  },

  async saveAccountSession(session: StoredAccountSession): Promise<void> {
    await backend.put("account_sessions", session.accountId, session)
    await backend.put("meta", "active_account_id", session.accountId)
  },

  async removeAccountSession(accountId: string): Promise<void> {
    await backend.del("account_sessions", accountId)
    await backend.del("assistant_keys", accountId)
    const active = await this.getActiveAccountId()
    if (active === accountId) {
      const rest = await this.listAccounts()
      await this.setActiveAccountId(rest[0]?.accountId ?? null)
    }
  },

  async clearAllAccountSessions(): Promise<void> {
    await backend.clearStore("account_sessions")
    await backend.clearStore("assistant_keys")
    await backend.del("meta", "active_account_id")
  },

  // ── Pinned E2EE device trust records (locally immutable require_e2ee) ──

  trustKey(accountId: string, deviceId: string): string {
    return `${accountId}::${deviceId}`
  },

  async getDeviceTrust(accountId: string, deviceId: string): Promise<ClientDeviceTrustRecord | null> {
    return backend.get<ClientDeviceTrustRecord>("device_trust", this.trustKey(accountId, deviceId))
  },

  async listDeviceTrusts(accountId: string): Promise<ClientDeviceTrustRecord[]> {
    const all = await backend.listAll<ClientDeviceTrustRecord & { _accountId?: string }>("device_trust")
    return all
      .filter((r) => !r._accountId || r._accountId === accountId)
      .map((row) => {
        const copy = { ...row }
        delete copy._accountId
        return copy
      })
  },

  async saveDeviceTrust(accountId: string, record: ClientDeviceTrustRecord): Promise<void> {
    // Enforce contract invariant: pinned records ALWAYS lock require_e2ee = true.
    const locked: ClientDeviceTrustRecord & { _accountId: string } = {
      ...record,
      require_e2ee: true,
      trust_tier: "web_browser",
      _accountId: accountId,
    }
    await backend.put("device_trust", this.trustKey(accountId, record.device_id), locked)
  },

  async removeDeviceTrust(accountId: string, deviceId: string): Promise<void> {
    await backend.del("device_trust", this.trustKey(accountId, deviceId))
  },

  // ── Cached per-device sessions (read-only when offline) ──

  async getDeviceSessionCache(accountId: string): Promise<Record<string, SessionListPayload>> {
    const all = await backend.listAll<CachedDeviceSessions>("session_cache")
    const out: Record<string, SessionListPayload> = {}
    for (const item of all) {
      if (item.accountId === accountId) out[item.deviceId] = item.payload
    }
    return out
  },

  async saveDeviceSessionCache(
    accountId: string,
    deviceId: string,
    payload: SessionListPayload
  ): Promise<void> {
    const key = `${accountId}::${deviceId}`
    await backend.put<CachedDeviceSessions>("session_cache", key, {
      key,
      accountId,
      deviceId,
      payload,
      updatedAt: Date.now(),
    })
  },

  // ── Local assistant conversations (dual-fingerprint sync) ──

  async listAssistantConversations(accountId: string): Promise<LocalAssistantConversation[]> {
    const all = await backend.listAll<LocalAssistantConversation>("assistant_conversations")
    return all.filter((c) => c.accountId === accountId).sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async getAssistantConversation(
    accountId: string,
    id: string
  ): Promise<LocalAssistantConversation | null> {
    return backend.get<LocalAssistantConversation>("assistant_conversations", `${accountId}::${id}`)
  },

  async saveAssistantConversation(conv: LocalAssistantConversation): Promise<void> {
    await backend.put("assistant_conversations", `${conv.accountId}::${conv.id}`, conv)
  },

  async deleteAssistantConversation(accountId: string, id: string): Promise<void> {
    await backend.del("assistant_conversations", `${accountId}::${id}`)
  },

  async clearEncryptedAssistantConversations(accountId: string): Promise<void> {
    const all = await this.listAssistantConversations(accountId)
    for (const item of all) {
      if (item.encrypted) await this.deleteAssistantConversation(accountId, item.id)
    }
  },

  // ── Cached unlocked assistant DEK ──

  async getCachedAssistantDek(accountId: string): Promise<CachedAssistantDek | null> {
    return backend.get<CachedAssistantDek>("assistant_keys", accountId)
  },

  async saveCachedAssistantDek(entry: CachedAssistantDek): Promise<void> {
    await backend.put("assistant_keys", entry.accountId, entry)
  },

  async clearCachedAssistantDek(accountId: string): Promise<void> {
    await backend.del("assistant_keys", accountId)
  },

  // ── Assistant VFS entries (OPFS metadata + IDB fallback content) ──

  async listVfsEntries(accountId: string): Promise<StoredVfsEntry[]> {
    const all = await backend.listAll<StoredVfsEntry>("assistant_vfs")
    return all
      .filter((e) => e.accountId === accountId)
      .sort((a, b) => a.path.localeCompare(b.path))
  },

  async getVfsEntry(accountId: string, path: string): Promise<StoredVfsEntry | null> {
    return backend.get<StoredVfsEntry>("assistant_vfs", `${accountId}::${path}`)
  },

  async saveVfsEntry(entry: StoredVfsEntry): Promise<void> {
    await backend.put("assistant_vfs", `${entry.accountId}::${entry.path}`, entry)
  },

  async deleteVfsEntry(accountId: string, path: string): Promise<void> {
    await backend.del("assistant_vfs", `${accountId}::${path}`)
  },

  // ── Experimental controlled mode: this browser's assistant as a device ──

  async getControlledDevice(accountId: string): Promise<ControlledDeviceCredential | null> {
    return backend.get<ControlledDeviceCredential>("meta", `controlled_device::${accountId}`)
  },

  async saveControlledDevice(entry: ControlledDeviceCredential): Promise<void> {
    await backend.put("meta", `controlled_device::${entry.accountId}`, entry)
  },

  async clearControlledDevice(accountId: string): Promise<void> {
    await backend.del("meta", `controlled_device::${accountId}`)
  },

  // ── Preferences ──

  async getPreferences(): Promise<UserPreferences> {
    const saved = await backend.get<Partial<UserPreferences>>("meta", "preferences")
    return {
      ...DEFAULT_PREFERENCES,
      ...saved,
      assistantMcpServers: saved?.assistantMcpServers ?? [],
      assistantExperimental: { ...DEFAULT_EXPERIMENTAL_PREFS, ...saved?.assistantExperimental },
    }
  },

  async updatePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
    const current = await this.getPreferences()
    const next: UserPreferences = {
      ...current,
      ...patch,
      assistantMcpServers: patch.assistantMcpServers ?? current.assistantMcpServers,
      assistantExperimental: { ...current.assistantExperimental, ...patch.assistantExperimental },
    }
    await backend.put("meta", "preferences", next)
    return next
  },

  async clearAll(): Promise<void> {
    for (const s of STORES) await backend.clearStore(s)
  },

  async _resetForTests(): Promise<void> {
    await backend.resetConnection()
  },
}
