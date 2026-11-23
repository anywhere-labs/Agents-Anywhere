/**
 * `aa.v3.Device`: this device's status, settings, files, git and pairing management.
 *
 * Every method passes the device gate first (`gate.assertBusinessCallAllowed`): on an encrypted device only paired
 * end-to-end clients get here. Settings and pairing are further limited: never from MCP, and pairing management
 * only from an authenticated, paired E2E client (the device's own CLI uses the local admin socket instead).
 */

import {
  InvalidArgumentError,
  MeshCallError,
  method,
  PermissionDeniedError,
  ResourceExhaustedError,
  service,
  UnavailableError,
  z,
  type RpcContext,
} from "meshcall";

import { ClientPlatformSchema, PairedClientEntrySchema, type PairedClientEntry } from "../core/config.js";
import { PAIRING_CODE_ID, type DeviceGate, type GateDecision } from "../core/gate.js";
import {
  DeviceOpsError,
  fetchDriveFile,
  getDeviceStatus,
  gitDiff,
  gitStatus,
  listDirs,
  readFile,
  saveAttachment,
  writeFile,
  type AttachmentLocation,
  type DriveDownload,
} from "../runtime/device-ops.js";
import type { ConnectorSettings } from "../runtime/state-store.js";
import { TerminalError } from "../runtime/terminal-manager.js";

// ── Error mapping (shared by the business services) ─────────────────────────────────────────────────────────────

/** Turn runtime errors into MeshCall errors with a stable `details.reason`. */
export function toRpcError(error: unknown): unknown {
  if (error instanceof MeshCallError) return error;
  if (error instanceof DeviceOpsError) {
    const options = { details: { reason: error.code } };
    switch (error.code) {
      case "not_found":
        return new MeshCallError("not_found", error.message, options);
      case "permission_denied":
        return new PermissionDeniedError(error.message, options);
      case "file_too_large_for_rpc":
      case "attachment_too_large":
        return new ResourceExhaustedError(error.message, options);
      case "git_unavailable":
      case "drive_unavailable":
        return new UnavailableError(error.message, options);
      case "drive_failed":
        return new UnavailableError(error.message, options);
      case "integrity_failed":
        return new MeshCallError("data_loss", error.message, options);
      case "git_failed":
        return new MeshCallError("failed_precondition", error.message, options);
      default:
        return new InvalidArgumentError(error.message, options);
    }
  }
  if (error instanceof TerminalError) {
    const options = { details: { reason: error.code } };
    switch (error.code) {
      case "terminal_not_found":
        return new MeshCallError("not_found", error.message, options);
      case "terminal_not_running":
      case "not_controller":
      case "agent_owned":
        return new MeshCallError("failed_precondition", error.message, options);
      case "terminal_limit_reached":
        return new ResourceExhaustedError(error.message, options);
      case "invalid_argument":
        return new InvalidArgumentError(error.message, options);
      default:
        return new UnavailableError(error.message, options);
    }
  }
  return error;
}

export async function rpcGuard<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toRpcError(error);
  }
}

// ── Host ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceServiceHost {
  readonly gate: DeviceGate;
  readonly deviceId: string;
  readonly dataDir: string;
  readonly connectorVersion: string;
  readonly startedAt: number;
  settings(): ConnectorSettings;
  /** Persist a settings change; a mode change is applied with the safe switch after this call answered. */
  updateSettings(patch: Partial<ConnectorSettings>): Promise<ConnectorSettings>;
  runtimes(): { id: string; name: string }[];
  /** A conversation's working directory (its attachments go to `<cwd>/.agents-anywhere/attachments/<id>/`). */
  sessionCwd?(sessionId: string): string | undefined;
  /** Cloud-drive download link for `fileId` as this device; undefined when the device has no control plane. */
  driveDownload?: ((fileId: string) => Promise<DriveDownload>) | undefined;
  /** Remove a client from the allowlist and end its live streams. */
  revokePairedClient(clientPub: string): boolean;
}

// ── Schemas ─────────────────────────────────────────────────────────────────────────────────────────────────────

const EmptySchema = z.object({});
const OkSchema = z.object({ ok: z.literal(true) });
const ModeSchema = z.enum(["normal", "encrypted"]);

export const DeviceSettingsResponseSchema = z.object({
  mode: ModeSchema,
  allow_mcp: z.boolean(),
  require_pairing_confirm: z.boolean(),
  max_rpc_file_bytes: z.number().int().positive(),
  device_name: z.string(),
});

const RuntimeSchema = z.object({ id: z.string(), name: z.string() });

export const DeviceStatusResponseSchema = z.object({
  device_id: z.string(),
  device_name: z.string(),
  platform: z.enum(["macos", "linux", "windows"]),
  hostname: z.string(),
  cwd: z.string(),
  arch: z.string(),
  node_version: z.string(),
  connector_version: z.string(),
  uptime_seconds: z.number().int().nonnegative(),
  mode: ModeSchema,
  allow_mcp: z.boolean(),
  runtimes: z.array(RuntimeSchema),
});

const UpdateSettingsSchema = z.object({
  mode: ModeSchema.nullish(),
  allow_mcp: z.boolean().nullish(),
  require_pairing_confirm: z.boolean().nullish(),
  max_rpc_file_bytes: z.number().int().positive().nullish(),
  device_name: z.string().trim().min(1).max(128).nullish(),
});

const ListDirsRequestSchema = z.object({ path: z.string().min(1).nullish() });
const ListDirsResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      is_dir: z.boolean(),
      is_symlink: z.boolean(),
      size: z.number(),
      mtime: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

const ReadFileRequestSchema = z.object({
  path: z.string().min(1),
  offset_bytes: z.number().int().nonnegative().nullish(),
  max_bytes: z.number().int().nonnegative().nullish(),
});
const ReadFileResponseSchema = z.object({
  path: z.string(),
  size: z.number(),
  offset: z.number(),
  bytes_read: z.number(),
  eof: z.boolean(),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
  mtime: z.string(),
});

const WriteFileRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).nullish(),
});
const WriteFileResponseSchema = z.object({ path: z.string(), size: z.number(), mtime: z.string() });

const GitStatusRequestSchema = z.object({ cwd: z.string().min(1) });
const GitStatusResponseSchema = z.looseObject({ is_repo: z.boolean() });
const GitDiffRequestSchema = z.object({
  cwd: z.string().min(1),
  file_path: z.string().min(1).nullish(),
  staged: z.boolean().nullish(),
  max_bytes: z.number().int().positive().nullish(),
});
const GitDiffResponseSchema = z.object({
  is_repo: z.boolean(),
  diff: z.string().optional(),
  truncated: z.boolean().optional(),
  bytes: z.number().optional(),
});

const SaveAttachmentRequestSchema = z.object({
  name: z.string().min(1).max(255),
  base64: z.string(),
  mime: z.string().max(128).nullish(),
  /** The conversation it is for: stored in that conversation's attachment folder. */
  session_id: z.string().min(1).max(128).nullish(),
});
const FetchDriveFileRequestSchema = z.object({
  file_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128).nullish(),
  name: z.string().min(1).max(255).nullish(),
  mime: z.string().max(128).nullish(),
  /** Hex SHA-256 of the stored drive object (ciphertext for encrypted files). */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).nullish(),
  /** base64url 32-byte AES-256-GCM key for `ephemeral_key` files (only over an E2E tunnel). */
  file_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullish(),
});
const SaveAttachmentResponseSchema = z.object({ id: z.string(), path: z.string(), name: z.string(), mime: z.string(), size: z.number() });

const PairedClientsResponseSchema = z.object({ clients: z.array(PairedClientEntrySchema) });
const RevokeRequestSchema = z.object({ client_pub: z.string().min(1) });
const RevokeResponseSchema = z.object({ ok: z.literal(true), revoked: z.boolean() });
const CreatePairingRequestSchema = z.object({
  /** `link` (default): an `aa-pair://` link for a QR code; `code`: a short code to type in. */
  kind: z.enum(["link", "code"]).nullish(),
  ttl_ms: z.number().int().positive().max(60 * 60 * 1000).nullish(),
  label: z.string().trim().min(1).max(128).nullish(),
  platform: ClientPlatformSchema.nullish(),
});
const CreatePairingResponseSchema = z.object({
  /** The `aa-pair://v1/…` link (kind `link`). */
  uri: z.string().optional(),
  /** The pairing code, XXXXX-XXXXX (kind `code`). */
  code: z.string().optional(),
  pairing_id: z.string(),
  expires_at: z.string(),
  /** Device key fingerprint, as the paired client shows it. */
  fingerprint: z.string(),
});

// ── Service ─────────────────────────────────────────────────────────────────────────────────────────────────────

function denyAdmin(decision: GateDecision, what: string): void {
  if (decision.via === "mcp") {
    throw new PermissionDeniedError(`external agents (MCP) cannot ${what}`, { details: { reason: "mcp_not_allowed" } });
  }
}

function requirePairedPeer(gate: DeviceGate, decision: GateDecision, what: string): string {
  denyAdmin(decision, what);
  const peer = decision.clientPub;
  if (!peer || !gate.isPaired(peer)) {
    throw new PermissionDeniedError(`only a paired end-to-end client (or this device itself) can ${what}`, {
      details: { reason: "e2e_peer_required" },
    });
  }
  return peer;
}

@service("aa.v3.Device", { targeted: true, description: "Status, settings, files, git and pairing of this device." })
export class DeviceService {
  readonly #host: DeviceServiceHost;

  constructor(host: DeviceServiceHost) {
    this.#host = host;
  }

  @method({ description: "Device status, mode and available agent runtimes.", readOnly: true, request: EmptySchema, response: DeviceStatusResponseSchema })
  status(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    const settings = this.#host.settings();
    return {
      ...getDeviceStatus({ connectorVersion: this.#host.connectorVersion, startedAt: this.#host.startedAt }),
      device_id: this.#host.deviceId,
      device_name: settings.device_name,
      mode: this.#host.gate.mode,
      allow_mcp: settings.allow_mcp,
      runtimes: this.#host.runtimes(),
    };
  }

  @method({ description: "Device-local settings.", readOnly: true, request: EmptySchema, response: DeviceSettingsResponseSchema })
  get_settings(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return { ...this.#host.settings() };
  }

  @method({
    description: "Change device settings. A mode change takes effect right after this call answers: every connection drops and the device serves again under the new policy.",
    idempotent: true,
    request: UpdateSettingsSchema,
    response: DeviceSettingsResponseSchema,
  })
  async update_settings(request: z.output<typeof UpdateSettingsSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    denyAdmin(decision, "change device settings");
    const patch: Partial<ConnectorSettings> = {};
    if (request.mode != null) patch.mode = request.mode;
    if (request.allow_mcp != null) patch.allow_mcp = request.allow_mcp;
    if (request.require_pairing_confirm != null) patch.require_pairing_confirm = request.require_pairing_confirm;
    if (request.max_rpc_file_bytes != null) patch.max_rpc_file_bytes = request.max_rpc_file_bytes;
    if (request.device_name != null) patch.device_name = request.device_name;
    return rpcGuard(() => this.#host.updateSettings(patch));
  }

  @method({ description: "List a directory (home when no path).", readOnly: true, request: ListDirsRequestSchema, response: ListDirsResponseSchema })
  async list_dirs(request: z.output<typeof ListDirsRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() => listDirs(request.path ?? undefined));
  }

  @method({ description: "Read a file, or a slice of it, within the RPC size cap.", readOnly: true, request: ReadFileRequestSchema, response: ReadFileResponseSchema })
  async read_file(request: z.output<typeof ReadFileRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() =>
      readFile(request.path, {
        maxRpcFileBytes: this.#host.settings().max_rpc_file_bytes,
        ...(request.offset_bytes != null ? { offsetBytes: request.offset_bytes } : {}),
        ...(request.max_bytes != null ? { maxBytes: request.max_bytes } : {}),
      }),
    );
  }

  @method({ description: "Write a file atomically.", idempotent: true, request: WriteFileRequestSchema, response: WriteFileResponseSchema })
  async write_file(request: z.output<typeof WriteFileRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() => writeFile(request.path, request.content, request.encoding ?? "utf8", this.#host.settings().max_rpc_file_bytes));
  }

  @method({ description: "git status of a working copy.", readOnly: true, request: GitStatusRequestSchema, response: GitStatusResponseSchema })
  async git_status(request: z.output<typeof GitStatusRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() => gitStatus(request.cwd));
  }

  @method({ description: "git diff of a working copy (bounded).", readOnly: true, request: GitDiffRequestSchema, response: GitDiffResponseSchema })
  async git_diff(request: z.output<typeof GitDiffRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() =>
      gitDiff(request.cwd, {
        ...(request.file_path != null ? { filePath: request.file_path } : {}),
        ...(request.staged != null ? { staged: request.staged } : {}),
        ...(request.max_bytes != null ? { maxBytes: request.max_bytes } : {}),
      }),
    );
  }

  @method({ description: "Store an attachment on the device for a later message.", idempotent: false, request: SaveAttachmentRequestSchema, response: SaveAttachmentResponseSchema })
  async save_attachment(request: z.output<typeof SaveAttachmentRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() =>
      saveAttachment(this.#host.dataDir, {
        name: request.name,
        base64: request.base64,
        maxBytes: this.#host.settings().max_rpc_file_bytes,
        ...(request.mime != null ? { mime: request.mime } : {}),
        location: this.#location(request.session_id),
      }),
    );
  }

  @method({
    description: "Download a large attachment from the cloud drive into a conversation's attachment folder.",
    idempotent: false,
    request: FetchDriveFileRequestSchema,
    response: SaveAttachmentResponseSchema,
  })
  async fetch_drive_file(request: z.output<typeof FetchDriveFileRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    const driveDownload = this.#host.driveDownload;
    if (!driveDownload) {
      throw new UnavailableError("this device is not connected to a control plane, so it cannot reach the cloud drive", {
        details: { reason: "drive_unavailable" },
      });
    }
    if (request.file_key != null && ctx.e2e == null) {
      throw new InvalidArgumentError("file_key may only be sent over an end-to-end encrypted tunnel", { details: { reason: "file_key_needs_e2e" } });
    }
    return rpcGuard(() =>
      fetchDriveFile(
        this.#host.dataDir,
        {
          fileId: request.file_id,
          ...(request.name != null ? { name: request.name } : {}),
          ...(request.mime != null ? { mime: request.mime } : {}),
          ...(request.sha256 != null ? { sha256: request.sha256 } : {}),
          ...(request.file_key != null ? { fileKey: request.file_key } : {}),
          location: this.#location(request.session_id),
        },
        driveDownload,
      ),
    );
  }

  #location(sessionId: string | null | undefined): AttachmentLocation {
    if (sessionId == null) return {};
    const cwd = this.#host.sessionCwd?.(sessionId);
    return { sessionId, ...(cwd ? { projectDir: cwd } : {}) };
  }

  @method({ description: "Clients paired with this device.", readOnly: true, request: EmptySchema, response: PairedClientsResponseSchema })
  list_paired_clients(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requirePairedPeer(this.#host.gate, decision, "list paired clients");
    return { clients: this.#host.gate.listPairedClients() satisfies PairedClientEntry[] };
  }

  @method({ description: "Remove a paired client; its live sessions end now and its next handshake fails.", destructive: true, request: RevokeRequestSchema, response: RevokeResponseSchema })
  revoke_paired_client(request: z.output<typeof RevokeRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requirePairedPeer(this.#host.gate, decision, "revoke paired clients");
    return { ok: true as const, revoked: this.#host.revokePairedClient(request.client_pub) };
  }

  @method({
    description: "Create a one-time pairing (link or code) for another client. Only from a paired end-to-end client: it carries the pairing secret.",
    idempotent: false,
    request: CreatePairingRequestSchema,
    response: CreatePairingResponseSchema,
  })
  async create_pairing(request: z.output<typeof CreatePairingRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requirePairedPeer(this.#host.gate, decision, "create pairings");
    if (ctx.e2e === null) {
      throw new PermissionDeniedError("a pairing link is only handed out inside an end-to-end session", { details: { reason: "e2e_peer_required" } });
    }
    const hint: { label?: string; platform?: z.output<typeof ClientPlatformSchema> } = {};
    if (request.label != null) hint.label = request.label;
    if (request.platform != null) hint.platform = request.platform;
    const gate = this.#host.gate;
    if (request.kind === "code") {
      const created = await gate.createPairingCode(request.ttl_ms ?? undefined, hint);
      return { code: created.code, pairing_id: PAIRING_CODE_ID, expires_at: created.expires_at, fingerprint: created.fingerprint };
    }
    const { uri, payload } = await gate.createPairing(request.ttl_ms ?? undefined, hint);
    return { uri, pairing_id: payload.pairing_id, expires_at: payload.expires_at, fingerprint: await gate.fingerprint() };
  }
}
