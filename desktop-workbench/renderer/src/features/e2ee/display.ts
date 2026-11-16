// Session display envelopes (contracts/e2ee/1.0 「加密的存放内容」, protocol 1.2 `displayDevice` / `displayUser`).
//
// In E2EE mode the Server keeps a session's title, working directory and preview only as sealed envelopes; the
// legacy `title` / `cwd` are null. This module opens them with the device's directory key and applies the
// display rule: title = displayUser.title ?? displayDevice.title, cwd = displayDevice.cwd. When a sealed
// envelope cannot be opened (no key for its `keyId`, wrong key, tampered payload) the session is "locked": the
// caller shows the 「加密中」 placeholder and never falls back to the Server's plaintext fields.
//
// Results are cached per (sessionId, slot, keyId, payload), so re-renders never decrypt twice. Failures are
// retried when the trust store changes (pairing, a new directory key from the device).

import { openDisplayEnvelope, type DisplaySlot } from "@/lib/e2ee/formats"
import type { ClientTrustStore } from "@/lib/e2ee/trust-store"
import { e2eeRuntime, onE2eeRuntimeChanged } from "./runtime"

export type SessionDisplayState = "plain" | "decrypted" | "locked"

export interface SessionDisplay {
  readonly title: string | null
  readonly cwd: string | null
  readonly preview: string | null
  /** `plain`: normal mode; `decrypted`: every sealed envelope opened; `locked`: at least one could not be opened. */
  readonly state: SessionDisplayState
}

export interface DisplayEnvelopeLike {
  readonly mode: string
  readonly keyId?: string | null
  readonly payload: unknown
}

/** The parts of a session view this module reads. */
export interface DisplaySource {
  readonly id: string
  readonly connectorId: string
  readonly title?: string | null
  readonly cwd?: string | null
  readonly displayDevice?: DisplayEnvelopeLike | null
  readonly displayUser?: DisplayEnvelopeLike | null
}

/** The directory key a device sealed an envelope with, or null when this client does not hold it. */
export type DisplayKeyResolver = (deviceId: string, keyId: string) => Promise<CryptoKey | Uint8Array | null>

type Fields = Readonly<Record<string, unknown>>
type Entry = { readonly status: "pending" } | { readonly status: "open"; readonly fields: Fields } | { readonly status: "failed" }

const CACHE_LIMIT = 4096

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function plainFields(envelope: DisplayEnvelopeLike | null | undefined): Fields | null {
  if (!envelope || envelope.mode !== "plain") return null
  let payload = envelope.payload
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Fields) : null
}

function isSealed(envelope: DisplayEnvelopeLike | null | undefined): envelope is DisplayEnvelopeLike {
  return envelope?.mode === "sealed"
}

export class SessionDisplayDecryptor {
  readonly #resolveKey: DisplayKeyResolver
  readonly #cache = new Map<string, Entry>()
  readonly #pending = new Map<string, Promise<void>>()
  readonly #listeners = new Set<() => void>()
  #version = 0
  #generation = 0
  #retries = 0

  constructor(resolveKey: DisplayKeyResolver) {
    this.#resolveKey = resolveKey
  }

  /** Bumps whenever a cached result changes; use it as a render dependency. */
  get version(): number {
    return this.#version
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * What to show for a session right now. Sealed envelopes not opened yet start decrypting in the background
   * (subscribers are told when they finish) and count as locked until then.
   */
  read(session: DisplaySource): SessionDisplay {
    const device = session.displayDevice
    const user = session.displayUser
    if (!isSealed(device) && !isSealed(user)) {
      // Normal mode: plaintext envelopes when the Server sends them, otherwise the legacy fields exactly as before.
      const deviceFields = plainFields(device)
      const userFields = plainFields(user)
      return {
        title: text(userFields?.title) ?? text(deviceFields?.title) ?? session.title ?? null,
        cwd: text(deviceFields?.cwd) ?? session.cwd ?? null,
        preview: text(deviceFields?.preview),
        state: "plain",
      }
    }
    // Encrypted mode: only what this client opened itself. Plaintext envelopes next to a sealed one and the
    // legacy fields come from the Server alone, so they are ignored.
    const deviceEntry = isSealed(device) ? this.#entry(session, "device", device) : null
    const userEntry = isSealed(user) ? this.#entry(session, "user", user) : null
    const deviceFields = deviceEntry?.status === "open" ? deviceEntry.fields : null
    const userFields = userEntry?.status === "open" ? userEntry.fields : null
    const locked = (deviceEntry !== null && !deviceFields) || (userEntry !== null && !userFields)
    // A renamed title that cannot be opened yet must not be replaced by the device's original one.
    const userTitleUnknown = userEntry !== null && !userFields
    return {
      title: text(userFields?.title) ?? (userTitleUnknown ? null : text(deviceFields?.title)),
      cwd: text(deviceFields?.cwd),
      preview: text(deviceFields?.preview),
      state: locked ? "locked" : "decrypted",
    }
  }

  /** Forgets failed attempts and tells subscribers to read again (a key arrived, the user paired). */
  retryLocked(): void {
    this.#retries += 1
    let changed = false
    for (const [key, entry] of this.#cache)
      if (entry.status === "failed") {
        this.#cache.delete(key)
        changed = true
      }
    if (changed) this.#changed()
  }

  /** Drops everything, decrypted results included (signed out, trust layer stopped). */
  reset(): void {
    this.#generation += 1
    this.#cache.clear()
    this.#pending.clear()
    this.#changed()
  }

  /** Waits until every envelope of these sessions has been tried; for tests and one-off reads. */
  async settle(sessions: readonly DisplaySource[]): Promise<SessionDisplay[]> {
    for (;;) {
      const results = sessions.map((session) => this.read(session))
      const pending = this.#pending
      if (pending.size === 0) return results
      await Promise.all(pending.values())
    }
  }

  #entry(session: DisplaySource, slot: DisplaySlot, envelope: DisplayEnvelopeLike): Entry {
    const keyId = envelope.keyId ?? ""
    const payload = typeof envelope.payload === "string" ? envelope.payload : ""
    const cacheKey = `${session.id}\u0000${slot}\u0000${keyId}\u0000${payload}`
    const cached = this.#cache.get(cacheKey)
    if (cached) return cached
    if (!keyId || !payload) return this.#store(cacheKey, { status: "failed" })
    const entry = this.#store(cacheKey, { status: "pending" })
    const generation = this.#generation
    const retries = this.#retries
    const target = { deviceId: session.connectorId, sessionId: session.id, slot, keyId }
    const work = (async (): Promise<Entry> => {
      try {
        const key = await this.#resolveKey(target.deviceId, keyId)
        if (!key) return { status: "failed" }
        const fields: unknown = await openDisplayEnvelope(key, target, payload)
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) return { status: "failed" }
        return { status: "open", fields: fields as Fields }
      } catch {
        return { status: "failed" }
      }
    })().then((result) => {
      if (generation !== this.#generation) return
      this.#pending.delete(cacheKey)
      // A key that arrived while this attempt ran: forget the failure so the next read tries again.
      if (result.status === "failed" && retries !== this.#retries) this.#cache.delete(cacheKey)
      else this.#store(cacheKey, result)
      this.#changed()
    })
    this.#pending.set(cacheKey, work)
    return entry
  }

  #store(cacheKey: string, entry: Entry): Entry {
    this.#cache.delete(cacheKey)
    this.#cache.set(cacheKey, entry)
    if (this.#cache.size > CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
    return entry
  }

  #changed(): void {
    this.#version += 1
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // listeners must not break decryption
      }
    }
  }
}

/** Directory keys from this client's trust store: the pinned device's key with that `keyId`. */
export function trustStoreDisplayKeys(store: ClientTrustStore): DisplayKeyResolver {
  return async (deviceId, keyId) => {
    const pin = await store.pin(deviceId)
    return pin ? store.directoryKey(pin, keyId)?.aes ?? null : null
  }
}

let shared: SessionDisplayDecryptor | null = null

/** The decryptor of this page, fed by the E2EE runtime's trust store; retries when keys or pairings change. */
export function sessionDisplayDecryptor(): SessionDisplayDecryptor {
  if (shared) return shared
  const decryptor = new SessionDisplayDecryptor(async (deviceId, keyId) => {
    const store = e2eeRuntime()?.store
    return store ? trustStoreDisplayKeys(store)(deviceId, keyId) : null
  })
  let unsubscribeStore: (() => void) | null = null
  let watched: ClientTrustStore | null = null
  const watch = () => {
    const store = e2eeRuntime()?.store ?? null
    if (store === watched) return
    unsubscribeStore?.()
    unsubscribeStore = store?.onChange(() => decryptor.retryLocked()) ?? null
    // Signed out: nothing decrypted for the previous account stays in memory.
    if (watched && !store) decryptor.reset()
    else decryptor.retryLocked()
    watched = store
  }
  onE2eeRuntimeChanged(watch)
  watch()
  shared = decryptor
  return decryptor
}

/** Applies the display rule to a session the UI renders: decrypted title and cwd, or the locked placeholder. */
export function withSessionDisplay<T extends DisplaySource & { title?: string | null; cwd?: string | null }>(
  session: T,
  display: SessionDisplay,
  labels: { locked: string; untitled: string },
): T & { displayState?: SessionDisplayState } {
  if (!session.displayDevice && !session.displayUser) return session
  if (display.state === "plain")
    return { ...session, title: display.title ?? labels.untitled, cwd: display.cwd, displayState: "plain" }
  return {
    ...session,
    title: display.title ?? (display.state === "locked" ? labels.locked : labels.untitled),
    cwd: display.cwd,
    displayState: display.state,
  }
}
