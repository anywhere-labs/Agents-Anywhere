import "fake-indexeddb/auto"

import { afterEach, describe, expect, it } from "vitest"

import { exportPlaceholderParams } from "@/lib/platform/export-params"
import {
  clientPlatform,
  clientTrustTier,
  controlFetchUrl,
  KEYCHAIN_PLACEHOLDER,
  openSecret,
  sealSecret,
  type DesktopBridge,
} from "@/lib/platform/desktop"
import { matchRouteParams } from "@/lib/platform/route-params"
import { buildWebTrustRecord } from "@/lib/mesh/pairing"
import { vault } from "@/lib/storage/idb"

/** Install a fake `window.aaDesktop` whose keychain is an in-memory map. */
function installDesktopBridge(available = true): Map<string, string> {
  const keychain = new Map<string, string>()
  const bridge = {
    version: "test",
    platform: "darwin",
    secureStore: {
      available: async () => available,
      get: async (key: string) => keychain.get(key) ?? null,
      set: async (key: string, value: string) => void keychain.set(key, value),
      delete: async (key: string) => void keychain.delete(key),
    },
  } as unknown as DesktopBridge
  ;(globalThis as { window?: unknown }).window = { aaDesktop: bridge }
  return keychain
}

afterEach(async () => {
  delete (globalThis as { window?: unknown }).window
  await vault.clearAll()
  await vault._resetForTests()
})

describe("desktop platform bridge", () => {
  it("is inert in the browser", async () => {
    expect(clientPlatform()).toBe("web")
    expect(clientTrustTier()).toBe("web_browser")
    expect(controlFetchUrl("https://aa.example.com/auth/login")).toBe("https://aa.example.com/auth/login")
    expect(await sealSecret("k", "v")).toBe("v")
    expect(await openSecret("k", "v")).toBe("v")
  })

  it("marks the desktop app as a verified (green-lock) client", () => {
    installDesktopBridge()
    expect(clientPlatform()).toBe("desktop")
    expect(clientTrustTier()).toBe("verified_app")
  })

  it("routes absolute control URLs through the app proxy and leaves relative ones alone", () => {
    installDesktopBridge()
    expect(controlFetchUrl("http://127.0.0.1:8790/auth/config")).toBe(
      `/api/remote?url=${encodeURIComponent("http://127.0.0.1:8790/auth/config")}`
    )
    expect(controlFetchUrl("/api/control/auth/config")).toBe("/api/control/auth/config")
  })

  it("keeps secrets in the keychain and only a placeholder in IndexedDB", async () => {
    const keychain = installDesktopBridge()
    expect(await sealSecret("rt", "refresh-token")).toBe(KEYCHAIN_PLACEHOLDER)
    expect(keychain.get("rt")).toBe("refresh-token")
    expect(await openSecret("rt", KEYCHAIN_PLACEHOLDER)).toBe("refresh-token")
    // Without a keychain the value stays where it was (browser behaviour).
    installDesktopBridge(false)
    expect(await sealSecret("rt", "refresh-token")).toBe("refresh-token")
  })

  it("stores the client private key and refresh tokens in the keychain through the vault", async () => {
    const keychain = installDesktopBridge()
    const identity = await vault.getOrCreateClientIdentity()
    expect(keychain.get("client_identity.private_key")).toBe(identity.privateKey)
    expect((await vault.getOrCreateClientIdentity()).privateKey).toBe(identity.privateKey)

    await vault.saveAccountSession({
      accountId: "/api/control::usr_1",
      serverUrl: "/api/control",
      authMode: "local",
      accessToken: "at",
      refreshToken: "rt-secret",
      expiresAt: Date.now() + 60_000,
      user: { id: "usr_1", email: "a@b.c", display_name: "A", role: "member" } as never,
      lastUsedAt: Date.now(),
    })
    expect(keychain.get("account./api/control::usr_1.refresh_token")).toBe("rt-secret")
    const [account] = await vault.listAccounts()
    expect(account?.refreshToken).toBe("rt-secret")

    await vault.removeAccountSession("/api/control::usr_1")
    expect(keychain.has("account./api/control::usr_1.refresh_token")).toBe(false)
  })

  it("makes a new client identity when the keychain lost the old key", async () => {
    const keychain = installDesktopBridge()
    const first = await vault.getOrCreateClientIdentity()
    keychain.clear()
    const second = await vault.getOrCreateClientIdentity()
    expect(second.clientId).not.toBe(first.clientId)
    expect(second.privateKey).not.toBe(KEYCHAIN_PLACEHOLDER)
  })

  it("records paired devices with the desktop trust tier", async () => {
    installDesktopBridge()
    const record = buildWebTrustRecord({
      v: 1,
      instance_id: "dev_1",
      device_pub: "A".repeat(43),
      pairing_id: "pair_1",
      psk: "B".repeat(43),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(record.trust_tier).toBe("verified_app")
  })
})

describe("desktop static export routes", () => {
  it("reads dynamic params from the URL", () => {
    expect(matchRouteParams("/sessions/[deviceId]/[sessionId]", "/sessions/dev_1/ses%202")).toEqual({
      deviceId: "dev_1",
      sessionId: "ses 2",
    })
    expect(matchRouteParams("/devices/[deviceId]", "/devices/dev_1")).toEqual({ deviceId: "dev_1" })
    expect(matchRouteParams("/devices/[deviceId]", "/sessions/dev_1/x")).toBeNull()
  })

  it("pre-renders no placeholder params outside the desktop export", () => {
    expect(exportPlaceholderParams("deviceId")).toEqual([])
  })
})
