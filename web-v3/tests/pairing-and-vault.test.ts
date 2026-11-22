import "fake-indexeddb/auto"

import { generateE2EKey, generateE2EPsk } from "meshcall/web"
import { describe, expect, it } from "vitest"

import {
  buildCodePairingPayload,
  buildWebTrustRecord,
  derivePairingCodePsk,
  encodePairingUri,
  formatKeyFingerprint,
  formatPairingCode,
  isPairingUriInput,
  normalizePairingCode,
  PAIRING_CODE_ID,
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

// Same vectors as contracts/aa-v3/1.0/fixtures/pairing-code.json (the Connector derives the PSK the same way).
const CODE_VECTORS = [
  { input: "7KQ2M-X9PTA", instance_id: "dev_fa7dce281d0548fc2d52a53f", code: "7KQ2MX9PTA", psk: "i_9rB4Qk4eF4KEi8X8IozFlFdCEpIMDkx0Ttlx7PXQQ" },
  { input: "7kq2m x9pta", instance_id: "dev_fa7dce281d0548fc2d52a53f", code: "7KQ2MX9PTA", psk: "i_9rB4Qk4eF4KEi8X8IozFlFdCEpIMDkx0Ttlx7PXQQ" },
  { input: "0123456789", instance_id: "dev_0000000000000000000000aa", code: "0123456789", psk: "_c_2OkN-_Fr22FMStkwUdhQZbT_vCFy1q4m6ppKTMGE" },
  { input: "OILZZ-ZZZZZ", instance_id: "dev_0000000000000000000000aa", code: "011ZZZZZZZ", psk: "typK8EfGoMlSBRgJ1fxrLY7Ft9d6YqyNJ1VJtB2wXww" },
]

describe("Pairing codes typed instead of scanned", () => {
  it("normalize and derive the PSK exactly like the contract vectors", async () => {
    for (const v of CODE_VECTORS) {
      expect(normalizePairingCode(v.input)).toBe(v.code)
      expect(await derivePairingCodePsk(v.input, v.instance_id)).toBe(v.psk)
    }
    for (const bad of ["", "7KQ2M-X9PT", "7KQ2M-X9PTAA", "7KQ2M-X9PTU", "7KQ2M_X9PTA"]) {
      expect(normalizePairingCode(bad)).toBeNull()
      await expect(derivePairingCodePsk(bad, "dev_1")).rejects.toMatchObject({ code: "invalid_pairing_code" })
    }
    expect(formatPairingCode("7kq2mx9pta")).toBe("7KQ2M-X9PTA")
    expect(isPairingUriInput("  aa-pair://v1/abc")).toBe(true)
    expect(isPairingUriInput("7KQ2M-X9PTA")).toBe(false)
  })

  it("build the pairing from the control plane's key hint and the fixed pairing id", async () => {
    const { publicKey } = await generateE2EKey()
    const payload = await buildCodePairingPayload("7KQ2M-X9PTA", { id: "dev_fa7dce281d0548fc2d52a53f", e2e_public_key_hint: publicKey })
    expect(payload.pairing_id).toBe(PAIRING_CODE_ID)
    expect(payload.device_pub).toBe(publicKey)
    expect(payload.psk).toBe(CODE_VECTORS[0].psk)
    await expect(buildCodePairingPayload("7KQ2M-X9PTA", { id: "dev_x", e2e_public_key_hint: null })).rejects.toMatchObject({
      code: "device_offline",
    })
  })

  it("never pin the server's key before the handshake proves it", async () => {
    const accountId = "https://aa.local::u-code"
    const { publicKey } = await generateE2EKey()
    let pinnedDuringHandshake: unknown = "not called"
    const control = {
      openTunnel: async (params: { deviceId: string; e2eKey?: string }) => {
        pinnedDuringHandshake = await vault.getDeviceTrust(accountId, params.deviceId)
        expect(params.e2eKey).toBe(publicKey)
        return {
          router_url: "wss://router.invalid",
          credential: "mtun_plain_credential",
          tunnel_id: "tun_1",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          mode: "normal",
        }
      },
    } as unknown as ControlPlaneClient
    const manager = new DeviceTunnelManager(accountId, control)
    const err = await manager
      .pairEncryptedDeviceWithCode({ id: "dev_code_1", name: "Build box", e2e_public_key_hint: publicKey }, "7KQ2M-X9PTA")
      .catch((e: unknown) => e)
    expect((err as PairingError).code).toBe("e2e_required_locally")
    expect(pinnedDuringHandshake).toBeNull()
    expect(await vault.getDeviceTrust(accountId, "dev_code_1")).toBeNull()
  })

  it("refuse a code pairing when the server's key differs from the pinned one", async () => {
    const accountId = "https://aa.local::u-code-swap"
    const pinned = await makeValidPayload({ instance_id: "dev_code_swap" })
    await vault.saveDeviceTrust(accountId, buildWebTrustRecord(pinned, "Laptop"))
    const { publicKey: other } = await generateE2EKey()
    const manager = new DeviceTunnelManager(accountId, {} as ControlPlaneClient)
    const err = await manager
      .pairEncryptedDeviceWithCode({ id: "dev_code_swap", name: "Laptop", e2e_public_key_hint: other }, "7KQ2M-X9PTA")
      .catch((e: unknown) => e)
    expect((err as PairingError).code).toBe("device_pub_mismatch")
    expect((await vault.getDeviceTrust(accountId, "dev_code_swap"))?.device_pub).toBe(pinned.device_pub)
  })
})
