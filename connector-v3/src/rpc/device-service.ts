/**
 * `aa.v3.Device`: this device's status, settings, agents, files, git and pairing management.
 *
 * Every method passes the device gate first (`gate.assertBusinessCallAllowed`): on an encrypted device only paired
 * end-to-end clients get here. Settings and pairing are further limited: never from MCP, and pairing management
 * only from an authenticated, paired E2E client (the device's own CLI uses the local admin socket instead).
 * Adding, changing, removing, stopping, installing or signing in to agents (`add_agent`, `update_agent`, `remove_agent`,
 * `stop_agent`, `install_agent`, `sign_in_agent`, `sign_in_terminal`) runs or ends programs, and changing model
 * providers (`save_provider`, `remove_provider`) writes CC Switch's data, so only a client over a
 * tunnel may: never the control plane's direct calls, never MCP. An install runs one of the catalog's fixed commands and
 * a sign-in the agent's own program, never a command of the caller's.
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

import { AgentIdSchema, AgentUpdateSchema, ClientPlatformSchema, GatewayKeySchema, GatewayUrlSchema, NewAgentSchema, PairedClientEntrySchema, type AgentUpdate, type NewAgent, type PairedClientEntry } from "../core/config.js";
import { PAIRING_CODE_ID, type DeviceGate, type GateDecision } from "../core/gate.js";
import type { AgentInfo, AgentInstallInfo } from "../runtime/acp-host.js";
import type { CcSwitchProvider, CcSwitchProviderInput } from "../runtime/cc-switch.js";
import { usageAgentOf, type SubscriptionUsage } from "../runtime/subscription-usage.js";
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
import { TerminalError, type TerminalInfo } from "../runtime/terminal-manager.js";
import { TerminalInfoSchema } from "./terminal-schema.js";

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

/** An agent with how many of its sessions run a turn now. */
export interface AgentStatus extends AgentInfo {
  busy: number;
}

export interface DeviceServiceHost {
  readonly gate: DeviceGate;
  readonly deviceId: string;
  readonly dataDir: string;
  readonly connectorVersion: string;
  readonly startedAt: number;
  settings(): ConnectorSettings;
  /** Persist a settings change; a mode change is applied with the safe switch after this call answered. */
  updateSettings(patch: Partial<ConnectorSettings>): Promise<ConnectorSettings>;
  /** The agents that can be used here (turned-off ones left out). */
  runtimes(): { id: string; name: string }[];
  /** Every agent, turned-off and not installed ones included, in the order of `runtimes()`. */
  agents(): AgentStatus[];
  /** The same, once the device was searched again for installed agents (with the PATH of a login shell read again). */
  refreshAgents(): Promise<AgentStatus[]>;
  /** Start installing an agent with one of its methods (`agents()` reports how it goes). */
  installAgent(id: string, method: string): Promise<AgentStatus>;
  /** Stop its install; resolves once it has ended. */
  cancelInstall(id: string): Promise<AgentStatus>;
  /** Change an agent (`invalid_argument` / `unknown_agent` for an id not registered here); resolves with it afterwards. */
  updateAgent(id: string, update: AgentUpdate): Promise<AgentStatus>;
  addAgent(input: NewAgent): Promise<AgentStatus>;
  removeAgent(id: string, options: { force?: boolean }): Promise<void>;
  /** Stop an agent's processes (`failed_precondition` / `turns_running` while turns run, unless `force`); how many. */
  stopAgent(id: string, options: { force: boolean }): Promise<number>;
  /** CC Switch's providers for an agent, and the one it answers through here. */
  listProviders(id: string): Promise<{ app: string; available: boolean; providers: CcSwitchProvider[]; selected?: string }>;
  saveProvider(id: string, input: CcSwitchProviderInput, providerId?: string): Promise<CcSwitchProvider>;
  removeProvider(id: string, providerId: string): Promise<void>;
  /** How much of its subscription the agent has used. */
  subscriptionUsage(id: string, refresh: boolean): Promise<SubscriptionUsage>;
  /** Sign in to an agent (ACP `authenticate`); resolves once signed in, asking again joins. */
  signInAgent(id: string, method: string): Promise<void>;
  cancelSignIn(id: string): void;
  /** Start a terminal in which the agent's program signs in. */
  signInTerminal(id: string, method: string, size: { cols?: number; rows?: number }): Promise<TerminalInfo>;
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

const AgentInstallSchema = z.object({
  /** The preferred one first; `available`: the program its command needs (`needs`) is there. */
  methods: z.array(z.object({ id: z.string(), command: z.string(), available: z.boolean(), needs: z.string().optional() })),
  /** The newest install since the Connector started. */
  job: z
    .object({
      method: z.string(),
      command: z.string(),
      state: z.enum(["waiting", "running", "succeeded", "failed", "cancelled"]),
      started_at: z.string(),
      ended_at: z.string().optional(),
      exit_code: z.number().int().optional(),
      /** Why it failed, when it was not its exit code. */
      error: z.string().optional(),
      /** The end of what it printed. */
      output: z.string(),
    })
    .optional(),
});

/** `agents` entry. Built field by field: the values of an agent's environment variables have no field to travel in. */
export const AgentEntrySchema = z.object({
  id: z.string(),
  /** Its preset's name: the agent's product name. */
  name: z.string(),
  /** One of the Connector's default presets. */
  builtin: z.boolean(),
  /** Added by the user (`add_agent`): it can be renamed and removed. */
  custom: z.literal(true).optional(),
  enabled: z.boolean(),
  /** What a process started now runs. */
  command: z.string(),
  args: z.array(z.string()),
  /** Names of its extra environment variables; the values never leave the device. */
  env_keys: z.array(z.string()),
  /** The command, args or environment differ from the preset. */
  customized: z.boolean(),
  /** Agent processes running now: sessions whose agent is up, prepared ones, ones still starting. */
  running: z.number().int().nonnegative(),
  /** Its sessions with a turn running now. */
  busy: z.number().int().nonnegative(),
  /**
   * Agents Anywhere's approvals turned on: only for agents that ask no one before they act and to which AA can add
   * that (Pi). Absent for every other agent.
   */
  approvals: z.boolean().optional(),
  /**
   * Agents that can be pointed at a model gateway: the API it must speak, whether it must be told a model, and the
   * gateway it uses now (its key never leaves the device). Absent for every other agent.
   */
  gateway: z
    .object({ api: z.enum(["anthropic", "openai-chat", "openai-responses"]), model_required: z.boolean(), base_url: z.string().optional(), model: z.string().optional() })
    .optional(),
  /**
   * Agents CC Switch keeps providers for: whether it does on this device, and the provider the agent answers through
   * here (`list_providers`); its name is absent when it is gone. Absent for every other agent.
   */
  cc_switch: z.object({ available: z.boolean(), provider: z.object({ id: z.string(), name: z.string().optional() }).optional() }).optional(),
  /** Its subscription's usage can be read (`subscription_usage`). */
  usage: z.boolean().optional(),
  /** Minutes a conversation's agent may sit idle before it is closed (restored by its next message); 0: never. */
  idle_close_minutes: z.number().int().nonnegative(),
  /** Conversations (and prepared ones) open in its processes. */
  sessions: z.number().int().nonnegative(),
  /** Known ways to sign in to it: of kind agent (`sign_in_agent`) or terminal (`sign_in_terminal`). The agent names its own once it was started. */
  sign_in: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), kind: z.enum(["agent", "terminal"]) })).optional(),
  /** It can be started here. Only an installed agent can be turned on and used. */
  installed: z.boolean(),
  /** Its own program, where it was found, or where the user said it is (`program_set`). */
  program: z.string().optional(),
  program_set: z.boolean().optional(),
  /** Its own program is there, but not this one, which starts it (`npx`). */
  missing: z.string().optional(),
  website: z.string().optional(),
  /** How it can be installed on this device (agents the Connector knows). */
  install: AgentInstallSchema.optional(),
});
export type AgentEntry = z.output<typeof AgentEntrySchema>;
const AgentsResponseSchema = z.object({ agents: z.array(AgentEntrySchema) });
export const UpdateAgentRequestSchema = AgentUpdateSchema.extend({ id: AgentIdSchema });
export const StopAgentRequestSchema = z.object({ id: AgentIdSchema, force: z.boolean().nullish() });
const InstallAgentRequestSchema = z.object({ id: AgentIdSchema, method: z.string().min(1).max(32) });
const AgentRequestSchema = z.object({ id: AgentIdSchema });
const SignInRequestSchema = z.object({ id: AgentIdSchema, method: z.string().min(1).max(256) });
const SignInTerminalRequestSchema = SignInRequestSchema.extend({
  cols: z.number().int().min(1).max(1000).nullish(),
  rows: z.number().int().min(1).max(1000).nullish(),
});
const StopAgentResponseSchema = z.object({ stopped: z.number().int().nonnegative() });

const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absent for the agent's own sign-in (CC Switch's official providers), which cannot be chosen here. */
  base_url: z.string().optional(),
  model: z.string().optional(),
  has_key: z.boolean(),
  official: z.boolean(),
  /** CC Switch has it in use: the agent's own configuration (and the agent in a terminal) answers through it. */
  current: z.boolean(),
  website: z.string().optional(),
});
const ProvidersResponseSchema = z.object({
  /** CC Switch's app of the agent. */
  app: z.string(),
  /** CC Switch keeps providers on this device. */
  available: z.boolean(),
  providers: z.array(ProviderSchema),
  /** The provider the agent answers through here; absent: its own configuration. */
  selected: z.string().optional(),
});
const SaveProviderRequestSchema = z.object({
  id: AgentIdSchema,
  /** The provider to change; absent: add one. */
  provider_id: z.string().min(1).max(256).nullish(),
  name: z.string().trim().min(1).max(128),
  base_url: GatewayUrlSchema,
  /** Required for a new one; absent: the saved key stays. Never sent back. */
  api_key: GatewayKeySchema.nullish(),
  /** An empty string removes it. */
  model: z.string().trim().max(256).nullish(),
});
const RemoveProviderRequestSchema = z.object({ id: AgentIdSchema, provider_id: z.string().min(1).max(256) });
const UsageRequestSchema = z.object({ id: AgentIdSchema, refresh: z.boolean().nullish() });
const UsageResponseSchema = z.object({
  status: z.enum(["ok", "signed_out", "expired", "refresh_pending", "error"]),
  plan: z.string().optional(),
  /** `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `30_day`, …; `used_percent` 0–100. */
  windows: z.array(z.object({ name: z.string(), used_percent: z.number(), resets_at: z.string().optional() })),
  extra: z.object({ enabled: z.boolean(), monthly_limit: z.number().optional(), used: z.number().optional(), currency: z.string().optional() }).optional(),
  credits: z.number().optional(),
  error: z.string().optional(),
  queried_at: z.number(),
});
const RemoveAgentResponseSchema = z.object({ removed: z.boolean() });

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

/**
 * Only a client over a tunnel: a plain tunnel on a normal device, a paired end-to-end session on an encrypted one
 * (the gate lets nothing else through there). Never the control plane's direct calls, never MCP.
 */
function requireClientTunnel(decision: GateDecision, what: string): void {
  denyAdmin(decision, what);
  if (decision.via !== "tunnel") {
    throw new PermissionDeniedError(`only a client connected through a tunnel can ${what}`, { details: { reason: "tunnel_required" } });
  }
}

/** The wire shape: every field named, so nothing else (an environment value, say) can ride along. */
function toAgentEntry(agent: AgentStatus): AgentEntry {
  return {
    id: agent.id,
    name: agent.name,
    builtin: agent.builtin,
    ...(agent.custom ? { custom: true as const } : {}),
    enabled: agent.enabled,
    command: agent.command,
    args: [...agent.args],
    env_keys: [...agent.envKeys],
    customized: agent.customized,
    running: agent.running,
    busy: agent.busy,
    ...(agent.approvals !== undefined ? { approvals: agent.approvals } : {}),
    ...(agent.gateway !== undefined
      ? {
          gateway: {
            api: agent.gateway.api,
            model_required: agent.gateway.modelRequired,
            ...(agent.gateway.baseUrl !== undefined ? { base_url: agent.gateway.baseUrl } : {}),
            ...(agent.gateway.model !== undefined ? { model: agent.gateway.model } : {}),
          },
        }
      : {}),
    ...(agent.ccSwitch !== undefined ? { cc_switch: agent.ccSwitch } : {}),
    ...(usageAgentOf(agent.id) !== undefined ? { usage: true } : {}),
    idle_close_minutes: agent.idleCloseMinutes,
    sessions: agent.sessions,
    ...(agent.signIn.length > 0 ? { sign_in: agent.signIn } : {}),
    installed: agent.installed,
    ...(agent.program !== undefined ? { program: agent.program } : {}),
    ...(agent.programSet ? { program_set: true } : {}),
    ...(agent.missing !== undefined ? { missing: agent.missing } : {}),
    ...(agent.website !== undefined ? { website: agent.website } : {}),
    ...(agent.install !== undefined ? { install: toInstall(agent.install) } : {}),
  };
}

function toProvider(provider: CcSwitchProvider): z.output<typeof ProviderSchema> {
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl !== undefined ? { base_url: provider.baseUrl } : {}),
    ...(provider.model !== undefined ? { model: provider.model } : {}),
    has_key: provider.hasKey,
    official: provider.official,
    current: provider.current,
    ...(provider.website !== undefined ? { website: provider.website } : {}),
  };
}

function toInstall(install: AgentInstallInfo): NonNullable<AgentEntry["install"]> {
  const job = install.job;
  return {
    methods: install.methods.map(({ id, command, available, needs }) => ({ id, command, available, ...(needs !== undefined ? { needs } : {}) })),
    ...(job !== undefined
      ? {
          job: {
            method: job.method,
            command: job.command,
            state: job.state,
            started_at: new Date(job.startedAt).toISOString(),
            ...(job.endedAt !== undefined ? { ended_at: new Date(job.endedAt).toISOString() } : {}),
            ...(job.exitCode !== undefined ? { exit_code: job.exitCode } : {}),
            ...(job.error !== undefined ? { error: job.error } : {}),
            output: job.output,
          },
        }
      : {}),
  };
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

@service("aa.v3.Device", { targeted: true, description: "Status, settings, agents, files, git and pairing of this device." })
export class DeviceService {
  readonly #host: DeviceServiceHost;

  constructor(host: DeviceServiceHost) {
    this.#host = host;
  }

  // ── Status and settings ──

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

  // ── Agents ──

  @method({
    description:
      "Every agent of this device, turned-off and not installed ones included, with its effective settings, running processes and how it can be installed. Environment variable values never leave the device: only their names.",
    readOnly: true,
    request: EmptySchema,
    response: AgentsResponseSchema,
  })
  agents(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return { agents: this.#host.agents().map(toAgentEntry) };
  }

  @method({
    description: "The same as agents, after the device was searched again for installed agents (the PATH of a login shell included, which takes a moment).",
    idempotent: true,
    request: EmptySchema,
    response: AgentsResponseSchema,
  })
  async refresh_agents(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    return { agents: (await rpcGuard(() => this.#host.refreshAgents())).map(toAgentEntry) };
  }

  @method({
    description:
      "Install an agent with one of the methods agents lists for it: a fixed command of the Connector's, run on the device without a terminal, after the installs started before it. agents reports how it goes. Only from a client over a tunnel.",
    idempotent: false,
    request: InstallAgentRequestSchema,
    response: AgentEntrySchema,
  })
  async install_agent(request: z.output<typeof InstallAgentRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "install agents");
    return toAgentEntry(await rpcGuard(() => this.#host.installAgent(request.id, request.method)));
  }

  @method({
    description: "Stop an agent's install that is waiting or running. Only from a client over a tunnel.",
    idempotent: true,
    request: AgentRequestSchema,
    response: AgentEntrySchema,
  })
  async cancel_install(request: z.output<typeof AgentRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "install agents");
    return toAgentEntry(await rpcGuard(() => this.#host.cancelInstall(request.id)));
  }

  @method({
    description:
      "Turn an agent on (only an installed one) or off, say where its program is, or change its command, args and extra environment variables (a string sets one, null removes it); reset goes back to the preset first. Its name is always the preset's. Idle conversations move to a process with the new settings at once, others when their turn has ended. Only from a client over a tunnel.",
    idempotent: true,
    request: UpdateAgentRequestSchema,
    response: AgentEntrySchema,
  })
  async update_agent(request: z.output<typeof UpdateAgentRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "change agents");
    const { id, ...update } = request;
    return toAgentEntry(await rpcGuard(() => this.#host.updateAgent(id, update)));
  }

  @method({
    description:
      "Add an agent of the user's own: a command that speaks ACP and is on the device. Its id is made from its name. Only from a client over a tunnel.",
    idempotent: false,
    request: NewAgentSchema,
    response: AgentEntrySchema,
  })
  async add_agent(request: z.output<typeof NewAgentSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "add agents");
    return toAgentEntry(await rpcGuard(() => this.#host.addAgent(request)));
  }

  @method({
    description:
      "Remove an agent the user added, its settings included. Its conversations stay, but cannot be continued. Refused while turns run unless force, which cancels them first. Only from a client over a tunnel.",
    destructive: true,
    idempotent: true,
    request: StopAgentRequestSchema,
    response: RemoveAgentResponseSchema,
  })
  async remove_agent(request: z.output<typeof StopAgentRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "remove agents");
    await rpcGuard(() => this.#host.removeAgent(request.id, { force: request.force === true }));
    return { removed: true };
  }

  @method({
    description:
      "Stop an agent's processes, prepared ones included; its conversations stay and start it again on their next message. Refused while turns run unless force, which cancels them first. Only from a client over a tunnel.",
    destructive: true,
    idempotent: true,
    request: StopAgentRequestSchema,
    response: StopAgentResponseSchema,
  })
  async stop_agent(request: z.output<typeof StopAgentRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "stop agents");
    return { stopped: await rpcGuard(() => this.#host.stopAgent(request.id, { force: request.force === true })) };
  }

  @method({
    description:
      "Sign in to an agent with one of the methods of kind agent that agent_auth_required listed: the agent is asked to (ACP authenticate), and may open a browser on the device. Answers once signed in; asking again joins the sign-in that runs, so a call that timed out is simply repeated. Only from a client over a tunnel.",
    idempotent: true,
    request: SignInRequestSchema,
    response: OkSchema,
  })
  async sign_in_agent(request: z.output<typeof SignInRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "sign in to agents");
    await rpcGuard(() => this.#host.signInAgent(request.id, request.method));
    return { ok: true as const };
  }

  @method({
    description: "End a sign-in that runs: what waits for it is refused (sign_in_cancelled). Only from a client over a tunnel.",
    idempotent: true,
    request: AgentRequestSchema,
    response: OkSchema,
  })
  async cancel_sign_in(request: z.output<typeof AgentRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "sign in to agents");
    await rpcGuard(() => this.#host.cancelSignIn(request.id));
    return { ok: true as const };
  }

  @method({
    description:
      "Start a terminal in which the agent's own program signs in, with one of the methods of kind terminal that agent_auth_required listed. Exit code 0: signed in. Only from a client over a tunnel.",
    idempotent: false,
    request: SignInTerminalRequestSchema,
    response: TerminalInfoSchema,
  })
  async sign_in_terminal(request: z.output<typeof SignInTerminalRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "sign in to agents");
    return rpcGuard(() =>
      this.#host.signInTerminal(request.id, request.method, {
        ...(request.cols != null ? { cols: request.cols } : {}),
        ...(request.rows != null ? { rows: request.rows } : {}),
      }),
    );
  }

  // ── Models and subscriptions (CC Switch) ──

  @method({
    description:
      "CC Switch's model providers for an agent (Claude Code, Codex) on this device, and the one it answers through here. Keys never leave the device.",
    readOnly: true,
    request: AgentRequestSchema,
    response: ProvidersResponseSchema,
  })
  async list_providers(request: z.output<typeof AgentRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    const listed = await rpcGuard(() => this.#host.listProviders(request.id));
    return { ...listed, providers: listed.providers.map(toProvider) };
  }

  @method({
    description:
      "Add a model provider to CC Switch for an agent's app, or change one (not the agent's own sign-in). Agents answering through it here use it from their next process. Only from a client over a tunnel.",
    idempotent: false,
    request: SaveProviderRequestSchema,
    response: ProviderSchema,
  })
  async save_provider(request: z.output<typeof SaveProviderRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "change model providers");
    const input = {
      name: request.name,
      baseUrl: request.base_url,
      ...(request.api_key ? { apiKey: request.api_key } : {}),
      ...(request.model != null ? { model: request.model } : {}),
    };
    return toProvider(await rpcGuard(() => this.#host.saveProvider(request.id, input, request.provider_id ?? undefined)));
  }

  @method({
    description:
      "Remove a model provider from CC Switch: not the one CC Switch has in use, nor one an agent answers through here. Only from a client over a tunnel.",
    destructive: true,
    idempotent: true,
    request: RemoveProviderRequestSchema,
    response: OkSchema,
  })
  async remove_provider(request: z.output<typeof RemoveProviderRequestSchema>, ctx: RpcContext) {
    const decision = this.#host.gate.assertBusinessCallAllowed(ctx);
    requireClientTunnel(decision, "change model providers");
    await rpcGuard(() => this.#host.removeProvider(request.id, request.provider_id));
    return { ok: true as const };
  }

  @method({
    description:
      "How much of its subscription an agent has used (Claude Code: Claude plans; Codex: ChatGPT plans), read with its own sign-in on this device; kept for a minute unless refresh.",
    readOnly: true,
    request: UsageRequestSchema,
    response: UsageResponseSchema,
  })
  async subscription_usage(request: z.output<typeof UsageRequestSchema>, ctx: RpcContext) {
    this.#host.gate.assertBusinessCallAllowed(ctx);
    const usage = await rpcGuard(() => this.#host.subscriptionUsage(request.id, request.refresh === true));
    return {
      status: usage.status,
      ...(usage.plan !== undefined ? { plan: usage.plan } : {}),
      windows: usage.windows.map((each) => ({ name: each.name, used_percent: each.usedPercent, ...(each.resetsAt !== undefined ? { resets_at: each.resetsAt } : {}) })),
      ...(usage.extra !== undefined
        ? {
            extra: {
              enabled: usage.extra.enabled,
              ...(usage.extra.monthlyLimit !== undefined ? { monthly_limit: usage.extra.monthlyLimit } : {}),
              ...(usage.extra.used !== undefined ? { used: usage.extra.used } : {}),
              ...(usage.extra.currency !== undefined ? { currency: usage.extra.currency } : {}),
            },
          }
        : {}),
      ...(usage.credits !== undefined ? { credits: usage.credits } : {}),
      ...(usage.error !== undefined ? { error: usage.error } : {}),
      queried_at: usage.queriedAt,
    };
  }

  // ── Files, git and attachments ──

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

  // ── Pairing ──

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
