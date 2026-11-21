// The device gate: the device half of AA v3 admission (docs/v3/e2ee-admission-proposal.md §2, §4, §5, §7).
//
// - Pairing: a one-time `pairing_id` + 32-byte PSK, shown only on this device as `aa-pair://v1/<base64url(json)>`.
//   MeshCall asks `getPairingPsk` for the PSK (read only) and then `authorizePeer`, which spends the pairing
//   atomically and adds the client's static key to the allowlist (Noise_IKpsk2).
// - Later connections (Noise_IK): `authorizePeer` accepts only keys on the allowlist.
// - Business calls: `assertBusinessCallAllowed` decides per call from `ctx.e2e`, `ctx.tunnel` and `ctx.metadata`.
//   Encrypted devices serve only authenticated, paired E2E sessions; normal devices trust the control plane and
//   accept MCP only when the device owner turned it on.
//
// Portable: Web Crypto and `meshcall` only, no Node built-ins.

import { e2ePublicKey, generateE2EKey, generateE2EPsk, PermissionDeniedError, z, type E2EPeer } from "meshcall";

import {
  Base64Url32Schema,
  InstantSchema,
  PairedClientEntrySchema,
  type ClientPlatform,
  type DeviceMode,
  type PairedClientEntry,
} from "./config.js";

// ── Pairing payload ─────────────────────────────────────────────────────────────────────────────────────────────

export const PAIRING_URI_PREFIX = "aa-pair://v1/";
export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

/** `PairingPayload` of `contracts/aa-v3/1.0/pairing.schema.json`. */
export const PairingPayloadSchema = z
  .object({
    v: z.literal(1),
    instance_id: z.string().min(1).max(128),
    device_pub: Base64Url32Schema,
    pairing_id: z.string().min(8).max(128),
    psk: Base64Url32Schema,
    expires_at: InstantSchema,
  })
  .strict();

export interface PairingPayload {
  v: 1;
  instance_id: string;
  device_pub: string;
  pairing_id: string;
  psk: string;
  expires_at: string;
}

export const PairingErrorCodeSchema = z.enum([
  "invalid_pairing_uri",
  "pairing_expired",
  "pairing_used",
  "e2e_handshake_failed",
  "device_pub_mismatch",
  "e2e_required_locally",
  "e2e_not_paired",
  "tunnel_revoked",
  "device_offline",
]);
export type PairingErrorCode = z.infer<typeof PairingErrorCodeSchema>;

/** A pairing problem with a stable `code` from `PairingErrorCode`. */
export class PairingError extends Error {
  override readonly name = "PairingError";
  constructor(
    readonly code: PairingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ── Business-call gate ──────────────────────────────────────────────────────────────────────────────────────────

/** Reasons `assertBusinessCallAllowed` refuses with (`PermissionDeniedError.reason`). */
export type GateDenyReason = "e2e_peer_required" | "e2e_not_paired" | "mcp_disabled_on_device";

/** The parts of a MeshCall `RpcContext` the gate reads; a real `RpcContext` fits. */
export interface GateCallContext {
  e2e?: { peerKey?: string | null } | null;
  tunnel?: { id: string; principal: string; sealed?: boolean } | null;
  metadata?: Readonly<Record<string, string>> | null;
}

/** Who a permitted call came from. `clientPub` is the authenticated client key (E2E sessions only). */
export interface GateDecision {
  via: "tunnel" | "control" | "mcp";
  clientPub?: string;
  /** `aa-on-behalf-of` set by the control plane: logging and local policy only, never a security boundary. */
  onBehalfOf?: string;
  /** `aa-mcp-client` set by the control plane for MCP calls. */
  mcpClient?: string;
}

export const META_VIA = "aa-via";
export const META_ON_BEHALF_OF = "aa-on-behalf-of";
export const META_MCP_CLIENT = "aa-mcp-client";

function deny(reason: GateDenyReason, message: string): PermissionDeniedError {
  return new PermissionDeniedError(message, { details: { reason } });
}

// ── DeviceGate ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingPairing {
  pairingId: string;
  psk: string;
  expiresAtMs: number;
  used: boolean;
  /** Recorded on the allowlist entry when the client pairs; editable later with `updatePairedClient`. */
  label?: string;
  platform?: ClientPlatform;
}

export interface PairingHint {
  label?: string;
  platform?: ClientPlatform;
}

export interface DeviceGateOptions {
  /** The MeshCall instance id, which is the AA device id. Bound in the pairing payload and IK handshakes. */
  instanceId: string;
  /** Device X25519 private key (base64url). */
  e2ePrivateKey: string;
  /** Its public key; derived from the private key when omitted (`DeviceGate.create`). */
  e2ePublicKey: string;
  mode?: DeviceMode;
  allowMcp?: boolean;
  requirePairingConfirm?: boolean;
  pairedClients?: Iterable<PairedClientEntry>;
  /** Persist the allowlist. A failure while pairing rolls the new client back. */
  onStateChange?: (pairedClients: PairedClientEntry[]) => void | Promise<void>;
  /** Asked only when `requirePairingConfirm` is on; no hook then means no new pairings (fail closed). */
  onPairingConfirm?: (peer: { peerKey: string; pairingId: string }) => boolean | Promise<boolean>;
  onClientPaired?: (entry: PairedClientEntry) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export type DeviceGateCreateOptions = Omit<DeviceGateOptions, "e2ePrivateKey" | "e2ePublicKey"> & {
  e2ePrivateKey?: string;
  e2ePublicKey?: string;
};

export class DeviceGate {
  readonly instanceId: string;
  readonly e2ePrivateKey: string;
  readonly e2ePublicKey: string;
  mode: DeviceMode;
  allowMcp: boolean;
  requirePairingConfirm: boolean;
  onStateChange?: DeviceGateOptions["onStateChange"];
  onPairingConfirm?: DeviceGateOptions["onPairingConfirm"];
  onClientPaired?: DeviceGateOptions["onClientPaired"];

  private readonly paired = new Map<string, PairedClientEntry>();
  private readonly pairings = new Map<string, PendingPairing>();
  private readonly now: () => number;

  constructor(options: DeviceGateOptions) {
    if (!options.instanceId) throw new TypeError("DeviceGate needs an instanceId");
    this.instanceId = options.instanceId;
    this.e2ePrivateKey = Base64Url32Schema.parse(options.e2ePrivateKey);
    this.e2ePublicKey = Base64Url32Schema.parse(options.e2ePublicKey);
    this.mode = options.mode ?? "normal";
    this.allowMcp = options.allowMcp ?? false;
    this.requirePairingConfirm = options.requirePairingConfirm ?? false;
    this.onStateChange = options.onStateChange;
    this.onPairingConfirm = options.onPairingConfirm;
    this.onClientPaired = options.onClientPaired;
    this.now = options.now ?? Date.now;
    for (const entry of options.pairedClients ?? []) {
      const parsed = PairedClientEntrySchema.parse(entry);
      this.paired.set(parsed.client_pub, parsed);
    }
  }

  /** A gate with a fresh device key pair, or the public half derived from a given private key. */
  static async create(options: DeviceGateCreateOptions): Promise<DeviceGate> {
    let privateKey = options.e2ePrivateKey;
    let publicKey = options.e2ePublicKey;
    if (privateKey === undefined) {
      const pair = await generateE2EKey();
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
    } else if (publicKey === undefined) {
      publicKey = await e2ePublicKey(privateKey);
    }
    return new DeviceGate({ ...options, e2ePrivateKey: privateKey, e2ePublicKey: publicKey });
  }

  // ── Pairing ──

  /**
   * A one-time pairing, valid for `ttlMs`. Show `uri` only on this device (QR code or one-time token); it carries
   * the PSK and must never be sent through the server.
   */
  async createPairing(ttlMs = DEFAULT_PAIRING_TTL_MS, hint: PairingHint = {}): Promise<{ uri: string; payload: PairingPayload }> {
    if (!(ttlMs > 0)) throw new RangeError("pairing ttl must be positive");
    this.sweepExpired();
    const pairingId = base64UrlEncode(randomBytes(18)); // 24 chars
    const psk = generateE2EPsk();
    const expiresAtMs = this.now() + ttlMs;
    const payload: PairingPayload = {
      v: 1,
      instance_id: this.instanceId,
      device_pub: this.e2ePublicKey,
      pairing_id: pairingId,
      psk,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
    this.pairings.set(pairingId, { pairingId, psk, expiresAtMs, used: false, ...hint });
    return { uri: encodePairingUri(payload), payload };
  }

  /** Decode and validate an `aa-pair://v1/…` URI. Does not check expiry (see `isPairingExpired`). */
  static parsePairingUri(uri: string): PairingPayload {
    return parsePairingUri(uri);
  }

  /** Drop a pairing nobody used yet (the user closed the QR dialog). */
  cancelPairing(pairingId: string): boolean {
    return this.pairings.delete(pairingId);
  }

  /** Pairings still waiting for a client. */
  listPendingPairings(): PendingPairing[] {
    this.sweepExpired();
    return [...this.pairings.values()].map((pairing) => ({ ...pairing }));
  }

  /**
   * MeshCall's `e2ePairingPsk` hook: the PSK of a live, unused pairing. Read only: spending happens in
   * `authorizePeer`, so a handshake that fails to decrypt does not burn the pairing.
   */
  getPairingPsk(pairingId: string): string | undefined {
    const pairing = this.pairings.get(pairingId);
    if (pairing === undefined || pairing.used) return undefined;
    if (this.now() >= pairing.expiresAtMs) {
      this.pairings.delete(pairingId);
      return undefined;
    }
    return pairing.psk;
  }

  /** MeshCall's `authorizeE2EPeer` hook. */
  async authorizePeer(peer: Pick<E2EPeer, "peerKey" | "pairingId">): Promise<boolean> {
    const peerKey = peer.peerKey;
    if (!peerKey || !Base64Url32Schema.safeParse(peerKey).success) return false;

    if (!peer.pairingId) {
      const entry = this.paired.get(peerKey);
      if (entry === undefined) return false;
      entry.last_seen_at = this.isoNow();
      void this.persist().catch(() => undefined); // last_seen_at is best effort
      return true;
    }

    // Spend the pairing synchronously, before the first await: a concurrent second handshake with the same
    // pairing id finds it gone.
    const pairingId = peer.pairingId;
    const pairing = this.pairings.get(pairingId);
    if (pairing === undefined || pairing.used) return false;
    pairing.used = true;
    this.pairings.delete(pairingId);
    if (this.now() >= pairing.expiresAtMs) return false;

    if (this.requirePairingConfirm) {
      if (this.onPairingConfirm === undefined) return false;
      let confirmed: boolean;
      try {
        confirmed = (await this.onPairingConfirm({ peerKey, pairingId })) === true;
      } catch {
        confirmed = false;
      }
      if (!confirmed) return false;
    }

    const previous = this.paired.get(peerKey);
    const at = this.isoNow();
    const entry: PairedClientEntry = {
      client_pub: peerKey,
      label: pairing.label ?? previous?.label ?? `Client ${peerKey.slice(0, 8)}`,
      platform: pairing.platform ?? previous?.platform ?? "cli",
      paired_at: at,
      last_seen_at: at,
    };
    this.paired.set(peerKey, entry);
    try {
      await this.persist();
    } catch {
      // Not remembered across a restart means not paired: roll back so the client re-pairs instead of being
      // dropped silently later.
      if (previous === undefined) this.paired.delete(peerKey);
      else this.paired.set(peerKey, previous);
      return false;
    }
    try {
      this.onClientPaired?.({ ...entry });
    } catch {
      // A notification failing does not undo the pairing.
    }
    return true;
  }

  /** The MeshCall mount options for this gate (`mount(services, { ...gate.mountOptions(), acceptTunnels })`). */
  mountOptions(): {
    instanceId: string;
    e2ePrivateKey: string;
    authorizeE2EPeer: (peer: E2EPeer) => Promise<boolean>;
    e2ePairingPsk: (pairingId: string) => string | undefined;
  } {
    return {
      instanceId: this.instanceId,
      e2ePrivateKey: this.e2ePrivateKey,
      authorizeE2EPeer: (peer) => this.authorizePeer(peer),
      e2ePairingPsk: (pairingId) => this.getPairingPsk(pairingId),
    };
  }

  // ── Allowlist ──

  listPairedClients(): PairedClientEntry[] {
    return [...this.paired.values()].map((entry) => ({ ...entry }));
  }

  isPaired(clientPub: string): boolean {
    return this.paired.has(clientPub);
  }

  /** Remove a client. The runtime must also drop that client's live sessions (MeshCall keeps them per tunnel). */
  revokePairedClient(clientPub: string): boolean {
    const removed = this.paired.delete(clientPub);
    if (removed) void this.persist().catch(() => undefined);
    return removed;
  }

  /** Rename a client or correct its platform (e.g. from the client's own registration call after pairing). */
  updatePairedClient(clientPub: string, patch: { label?: string; platform?: ClientPlatform }): PairedClientEntry | undefined {
    const entry = this.paired.get(clientPub);
    if (entry === undefined) return undefined;
    const next = PairedClientEntrySchema.parse({ ...entry, ...patch });
    this.paired.set(clientPub, next);
    void this.persist().catch(() => undefined);
    return { ...next };
  }

  // ── Business calls ──

  /**
   * Throws `PermissionDeniedError` unless this call may reach a business service (`aa.v3.Sessions`, `Terminals`,
   * `Device`). `aa.v3.DeviceAdmin` is content-free and does not go through here.
   */
  assertBusinessCallAllowed(ctx: GateCallContext): GateDecision {
    const metadata = ctx.metadata ?? {};
    const via = metadata[META_VIA];
    const onBehalfOf = metadata[META_ON_BEHALF_OF];

    if (this.mode === "encrypted") {
      const peerKey = ctx.e2e?.peerKey;
      if (!peerKey) {
        throw deny("e2e_peer_required", "this device is encrypted: calls are accepted only in an authenticated end-to-end session");
      }
      if (!this.paired.has(peerKey)) {
        throw deny("e2e_not_paired", "this client is not paired with the device (or was revoked); scan the device's QR code again");
      }
      if (via === "mcp") {
        throw deny("e2e_peer_required", "an encrypted device never accepts MCP control");
      }
      return { via: "tunnel", clientPub: peerKey };
    }

    if (via === "mcp") {
      if (!this.allowMcp) {
        throw deny("mcp_disabled_on_device", "external agent (MCP) control is turned off on this device");
      }
      const decision: GateDecision = { via: "mcp" };
      if (onBehalfOf) decision.onBehalfOf = onBehalfOf;
      const mcpClient = metadata[META_MCP_CLIENT];
      if (mcpClient) decision.mcpClient = mcpClient;
      return decision;
    }

    if (ctx.tunnel) {
      const decision: GateDecision = { via: "tunnel" };
      const peerKey = ctx.e2e?.peerKey;
      if (peerKey) decision.clientPub = peerKey;
      return decision;
    }

    const decision: GateDecision = { via: "control" };
    if (onBehalfOf) decision.onBehalfOf = onBehalfOf;
    return decision;
  }

  // ── Internals ──

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [id, pairing] of this.pairings) {
      if (pairing.used || now >= pairing.expiresAtMs) this.pairings.delete(id);
    }
  }

  private async persist(): Promise<void> {
    await this.onStateChange?.(this.listPairedClients());
  }
}

// ── URI encoding ────────────────────────────────────────────────────────────────────────────────────────────────

export function encodePairingUri(payload: PairingPayload): string {
  return PAIRING_URI_PREFIX + base64UrlEncode(new TextEncoder().encode(JSON.stringify(PairingPayloadSchema.parse(payload))));
}

export function parsePairingUri(uri: string): PairingPayload {
  const value = typeof uri === "string" ? uri.trim() : "";
  if (!value.startsWith(PAIRING_URI_PREFIX)) {
    throw new PairingError("invalid_pairing_uri", `a pairing link starts with ${PAIRING_URI_PREFIX}`);
  }
  let json: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(value.slice(PAIRING_URI_PREFIX.length)));
    json = JSON.parse(text);
  } catch {
    throw new PairingError("invalid_pairing_uri", "the pairing link is damaged (not base64url JSON)");
  }
  const parsed = PairingPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new PairingError("invalid_pairing_uri", `the pairing link is not a v1 pairing: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export function isPairingExpired(payload: PairingPayload, nowMs: number = Date.now()): boolean {
  return nowMs >= Date.parse(payload.expires_at);
}

// ── Bytes ───────────────────────────────────────────────────────────────────────────────────────────────────────

function randomBytes(size: number): Uint8Array {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues === undefined) throw new Error("the device gate needs WebCrypto (crypto.getRandomValues)");
  return crypto.getRandomValues(new Uint8Array(size));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) throw new RangeError("not base64url");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _GateSchemaChecks = [Assert<Same<z.infer<typeof PairingPayloadSchema>, PairingPayload>>];
