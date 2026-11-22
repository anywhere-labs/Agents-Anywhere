import "fake-indexeddb/auto"

import { generateE2EKey, generateE2EPsk } from "meshcall/web"
import { describe, expect, it } from "vitest"

import {
  buildWebTrustRecord,
  encodePairingUri,
  formatKeyFingerprint,
  PairingError,
  parsePairingUri,
  trustTierToBadge,
} from "@/lib/mesh/pairing"
import type { ControlPlaneClient } from "@/lib/mesh/control-client"
import { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { vault } from "@/lib/storage/idb"
import type { PairingPayload } from "@/lib/types/v3"

async function makeValidPayload(overrides: Partial<PairingPayload> = {}): Promise<PairingPayload> {
  const pair = await generateE2EKey()
  return {
    v: 1,
    instance_id: "dev_encrypted_01",
    device_pub: pair.publicKey,
    pairing_id: "pair_12345678",
    psk: generateE2EPsk(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  }
}

describe("Out-of-band pairing URI & Web grey-lock policy", () => {
  it("encodes and parses valid aa-pair://v1/... URIs", async () => {
    const payload = await makeValidPayload()
    const uri = encodePairingUri(payload)
    expect(uri.startsWith("aa-pair://v1/")).toBe(true)

    const parsed = parsePairingUri(uri)
    expect(parsed).toEqual(payload)

    const fp1 = await formatKeyFingerprint(parsed.device_pub)
    const fp2 = await formatKeyFingerprint(parsed.device_pub)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){7}$/)
  })

  it("rejects wrong scheme, expired URI, unknown fields, and malformed keys", async () => {
    expect(() => parsePairingUri("https://example.com/pair")).toThrow(PairingError)

    const expired = await makeValidPayload({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    try {
      parsePairingUri(encodePairingUri(expired))
      expect.unreachable("should reject expired pairing URI")
    } catch (err) {
      expect(err).toBeInstanceOf(PairingError)
      expect((err as PairingError).code).toBe("pairing_expired")
    }

    const withExtra = { ...(await makeValidPayload()), malicious_extra: "nope" }
    const b64 = btoa(JSON.stringify(withExtra))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(() => parsePairingUri(`aa-pair://v1/${b64}`)).toThrow(PairingError)
  })

  it("maps web_browser strictly to grey lock and verified_app to green lock", async () => {
    expect(trustTierToBadge("web_browser")).toBe("grey")
    expect(trustTierToBadge("verified_app")).toBe("green")

    const record = buildWebTrustRecord(await makeValidPayload(), "Studio Mac")
    expect(record.require_e2ee).toBe(true)
    expect(record.trust_tier).toBe("web_browser")
    expect(record.device_name_hint).toBe("Studio Mac")
  })
})

describe("Browser IndexedDB local vault", () => {
  it("persists client X25519 identity, multi-account sessions, and locked E2EE trusts", async () => {
    const id1 = await vault.getOrCreateClientIdentity()
    const id2 = await vault.getOrCreateClientIdentity()
    expect(id1.clientId).toBe(id2.clientId)
    expect(id1.publicKey).toBe(id2.publicKey)
    expect(id1.privateKey).toBe(id2.privateKey)

    const accountId = "https://aa.local::u1"
    await vault.saveAccountSession({
      accountId,
      serverUrl: "https://aa.local",
      authMode: "local",
      accessToken: "tok-1",
      refreshToken: "ref-1",
      expiresAt: Date.now() + 3600_000,
      user: {
        id: "u1",
        email: "alice@example.com",
        display_name: "Alice",
        role: "admin",
        created_at: "2026-11-22T00:00:00Z",
        plan: null,
        entitlements: {},
        active_context: null,
      },
      lastUsedAt: Date.now(),
    })

    const accounts = await vault.listAccounts()
    expect(accounts.some((a) => a.accountId === accountId)).toBe(true)

    const payload = await makeValidPayload({ instance_id: "dev_pin_01" })
    await vault.saveDeviceTrust(accountId, buildWebTrustRecord(payload, "Work Laptop"))
    const fetched = await vault.getDeviceTrust(accountId, "dev_pin_01")
    expect(fetched?.require_e2ee).toBe(true)
    expect(fetched?.trust_tier).toBe("web_browser")
    expect(fetched?.device_pub).toBe(payload.device_pub)

    // Regenerating browser identity rotates keypair and clears all pinned trusts
    const rotated = await vault.regenerateClientIdentity()
    expect(rotated.publicKey).not.toBe(id1.publicKey)
    const afterReset = await vault.getDeviceTrust(accountId, "dev_pin_01")
    expect(afterReset).toBeNull()
  })
})

describe("Encrypted device pairing keeps the local pin", () => {
  const accountId = "https://aa.local::u-pin"
  // A control plane that refuses to hand out an E2E tunnel: pairing fails before any network handshake.
  const plaintextControl = {
    openTunnel: async () => ({
      router_url: "wss://router.invalid",
      credential: "mtun_plain_credential",
      tunnel_id: "tun_1",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      mode: "normal",
    }),
  } as unknown as ControlPlaneClient

  it("refuses a link whose device key differs from the pinned one", async () => {
    const pinned = await makeValidPayload({ instance_id: "dev_pin_swap" })
    await vault.saveDeviceTrust(accountId, buildWebTrustRecord(pinned, "Laptop"))

    const forged = await makeValidPayload({ instance_id: "dev_pin_swap" })
    const manager = new DeviceTunnelManager(accountId, plaintextControl)
    const err = await manager.pairEncryptedDevice(encodePairingUri(forged)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PairingError)
    expect((err as PairingError).code).toBe("device_pub_mismatch")
    expect((await vault.getDeviceTrust(accountId, "dev_pin_swap"))?.device_pub).toBe(pinned.device_pub)
  })

  it("removes the trust record of a first pairing that did not complete", async () => {
    const payload = await makeValidPayload({ instance_id: "dev_pin_fail" })
    const manager = new DeviceTunnelManager(accountId, plaintextControl)
    const err = await manager.pairEncryptedDevice(encodePairingUri(payload)).catch((e: unknown) => e)
    expect((err as PairingError).code).toBe("e2e_required_locally")
    expect(await vault.getDeviceTrust(accountId, "dev_pin_fail")).toBeNull()
  })

  it("restores the previous record when re-pairing the same key fails", async () => {
    const payload = await makeValidPayload({ instance_id: "dev_pin_again" })
    const previous = { ...buildWebTrustRecord(payload, "Old name"), paired_at: "2026-01-01T00:00:00.000Z" }
    await vault.saveDeviceTrust(accountId, previous)
    const manager = new DeviceTunnelManager(accountId, plaintextControl)
    await manager.pairEncryptedDevice(encodePairingUri(payload), "New name").catch(() => undefined)
    const after = await vault.getDeviceTrust(accountId, "dev_pin_again")
    expect(after?.paired_at).toBe("2026-01-01T00:00:00.000Z")
    expect(after?.device_name_hint).toBe("Old name")
  })
})
