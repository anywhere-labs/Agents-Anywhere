// Device configuration shapes for the AA v3 Connector.
//
// Portable on purpose (browser / WebView / Node): no Node built-ins. Persisting these values (files, keychains) is
// the job of `src/runtime/*`; this module only defines the shapes, their defaults and their validation.
//
// Contracts: `contracts/aa-v3/1.0/control.schema.json` (DeviceMode, DevicePlatform) and
// `contracts/aa-v3/1.0/pairing.schema.json` (PairedClientEntry).

import { z } from "meshcall";

// ── Shared primitives ───────────────────────────────────────────────────────────────────────────────────────────

/** 32 raw bytes as unpadded base64url: an X25519 public / private key or a pairing PSK. */
export const Base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "expected 32 bytes of unpadded base64url");

/** RFC 3339 timestamp with a zone (`Z` or an offset), as the contracts' `format: date-time`. */
export const InstantSchema = z.iso.datetime({ offset: true });

// ── Device mode and platform ────────────────────────────────────────────────────────────────────────────────────

export const DeviceModeSchema = z.enum(["normal", "encrypted"]);
/** `normal` trusts the control plane; `encrypted` serves business calls only inside paired E2E sessions. */
export type DeviceMode = z.infer<typeof DeviceModeSchema>;

export const DevicePlatformSchema = z.enum(["macos", "linux", "windows"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

// ── Device settings ─────────────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_RPC_FILE_BYTES = 8 * 1024 * 1024;

export const DeviceSettingsSchema = z.object({
  mode: DeviceModeSchema.default("normal"),
  /** 「允许外部 Agent 控制」: accept `aa-via: mcp` calls on a normal device. Off by default. */
  allow_mcp: z.boolean().default(false),
  /** Ask a person at the device before a new pairing takes effect. Off by default for headless devices. */
  require_pairing_confirm: z.boolean().default(false),
  /** Largest file a single RPC may carry (read_file / upload). */
  max_rpc_file_bytes: z.number().int().positive().default(DEFAULT_MAX_RPC_FILE_BYTES),
  /** Shown to the server and other clients; the server can see it even on an encrypted device. */
  device_name: z.string().min(1).max(128),
});

export interface DeviceSettings {
  mode: DeviceMode;
  allow_mcp: boolean;
  require_pairing_confirm: boolean;
  max_rpc_file_bytes: number;
  device_name: string;
}

/** Fill in defaults and validate; throws a `ZodError` for anything malformed. */
export function parseDeviceSettings(input: unknown): DeviceSettings {
  return DeviceSettingsSchema.parse(input);
}

export function defaultDeviceSettings(deviceName: string): DeviceSettings {
  return parseDeviceSettings({ device_name: deviceName });
}

// ── Paired clients (device-side allowlist) ──────────────────────────────────────────────────────────────────────

export const ClientPlatformSchema = z.enum(["ios", "android", "desktop", "web", "cli"]);
export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;

/** `PairedClientEntry` of `pairing.schema.json`: one client static key this device accepts. */
export const PairedClientEntrySchema = z
  .object({
    client_pub: Base64Url32Schema,
    label: z.string().min(1).max(128),
    platform: ClientPlatformSchema,
    paired_at: InstantSchema,
    last_seen_at: InstantSchema.optional(),
  })
  .strict();

export interface PairedClientEntry {
  client_pub: string;
  label: string;
  platform: ClientPlatform;
  paired_at: string;
  last_seen_at?: string;
}

// ── Device identity ─────────────────────────────────────────────────────────────────────────────────────────────

export const DeviceIdentitySchema = z.object({
  /** Also the MeshCall instance id. */
  device_id: z.string().min(1).max(128),
  /** Exchanged with the control plane for Router tokens; the server stores only its digest. */
  device_secret: z.string().min(1),
  control_url: z.string().min(1),
  /** X25519 static key for E2E tunnels (base64url). Never leaves the device. */
  e2e_private_key: Base64Url32Schema.optional(),
  e2e_public_key: Base64Url32Schema.optional(),
});

export interface DeviceIdentity {
  device_id: string;
  device_secret: string;
  control_url: string;
  e2e_private_key?: string;
  e2e_public_key?: string;
}

// ── ACP runtime presets ─────────────────────────────────────────────────────────────────────────────────────────

/** A command that speaks ACP (JSON-RPC 2.0 over stdio), e.g. `codex-acp`, `claude-code-acp`. */
export const AcpRuntimePresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  approvals: z.literal("pi").optional(),
  own_process: z.boolean().optional(),
});

export interface AcpRuntimePreset {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * The agent asks no one before it acts, and AA can add that: `"pi"`, with its Pi extension (`core/pi-approvals.ts`),
   * once the agent's `approvals` setting is turned on.
   */
  approvals?: "pi";
  /**
   * Every conversation gets a process of its own. Only for an agent that cannot run several ACP sessions in one
   * process: the others share one process per agent.
   */
  own_process?: boolean;
}

// ── Per-agent settings (`aa.v3.Device/update_agent`) ────────────────────────────────────────────────────────────

/** The names an agent's extra environment variables may have. */
export const AGENT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Extra environment variables one agent may have. */
export const MAX_AGENT_ENV_VARS = 128;
/** The longest an agent's idle processes may be kept before they are closed: a week. */
export const MAX_IDLE_CLOSE_MINUTES = 7 * 24 * 60;

const noNul = (value: string): boolean => !value.includes("\u0000");
const NO_NUL = "must not contain NUL characters";

export const AgentIdSchema = z.string().min(1).max(64);
export const AgentCommandSchema = z.string().trim().min(1).max(4096).refine(noNul, NO_NUL);
/** Where an agent's program is on the device. */
export const AgentProgramSchema = z.string().trim().max(4096).refine(noNul, NO_NUL);
export const AgentArgsSchema = z.array(z.string().max(4096).refine(noNul, NO_NUL)).max(256);
export const AgentEnvNameSchema = z.string().max(256).regex(AGENT_ENV_NAME_PATTERN, "must match ^[A-Za-z_][A-Za-z0-9_]*$");
export const AgentEnvValueSchema = z.string().max(32_768).refine(noNul, NO_NUL);
/** An agent's extra environment variables. */
export const AgentEnvSchema = z
  .record(AgentEnvNameSchema, AgentEnvValueSchema)
  .refine((env) => Object.keys(env).length <= MAX_AGENT_ENV_VARS, `at most ${MAX_AGENT_ENV_VARS} environment variables`);
export const AgentNameSchema = z.string().trim().min(1).max(128).refine(noNul, NO_NUL);

/** Where a model gateway is: `http(s)`, without a user, query or fragment. */
export const GatewayUrlSchema = z.string().trim().max(2048).refine(isGatewayUrl, "must be an http(s) address without a user, query or fragment");
export const GatewayKeySchema = z.string().trim().max(8192).refine(noNul, NO_NUL);
export const GatewayModelSchema = z.string().trim().max(256).refine(noNul, NO_NUL);

/** The model gateway of an agent (`core/agent-gateway.ts`). */
export const ModelGatewaySchema = z.object({
  base_url: GatewayUrlSchema,
  api_key: GatewayKeySchema.min(1),
  model: GatewayModelSchema.min(1).optional(),
});
export interface ModelGateway {
  base_url: string;
  api_key: string;
  model?: string;
}

function isGatewayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && !/[?#]/u.test(value);
}

/**
 * What this device changed about one agent against its preset: turned off, where its program is, a model gateway, or
 * another command, args or set of extra environment variables. The name is always the preset's (the agent's product
 * name). `env`, when present, is the agent's whole set of extra variables (it takes the place of the preset's). Kept
 * only on the device (`agents.json`, 0600): the values of `env` and the gateway's key never leave it. Keys it does not
 * know (a `name` saved by an earlier Connector) are dropped when it is read.
 */
export const AgentOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  /** AA's approvals turned on (agents whose preset has `approvals`); off is not stored. */
  approvals: z.boolean().optional(),
  /** Close a conversation's agent after this many minutes idle; never (the default) is not stored. */
  idle_close_minutes: z.number().int().min(1).max(MAX_IDLE_CLOSE_MINUTES).optional(),
  /** The agent's program, where the user said it is (agents of the catalog); searched for otherwise. */
  program: AgentProgramSchema.min(1).optional(),
  /** Its model requests go to this gateway (agents of the catalog that can be pointed at one). */
  gateway: ModelGatewaySchema.optional(),
  /** How the user signed in to it last (ACP `authenticate`): a process that asks for it is signed in to this way. */
  sign_in: z.string().min(1).max(256).optional(),
  command: AgentCommandSchema.optional(),
  args: AgentArgsSchema.optional(),
  env: AgentEnvSchema.optional(),
});

export interface AgentOverride {
  enabled?: boolean;
  approvals?: boolean;
  idle_close_minutes?: number;
  program?: string;
  gateway?: ModelGateway;
  sign_in?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Every agent's override, by agent id. */
export const AgentOverridesSchema = z.record(AgentIdSchema, AgentOverrideSchema);
export type AgentOverrides = Record<string, AgentOverride>;

/**
 * A change to one agent (`update_agent` without its `id`). Absent or `null` fields stay as they are; in `env` a
 * string sets the variable and `null` removes it. `reset` first drops the changes to the command, args and
 * environment (back to the preset), then applies the other fields; it leaves `enabled`, `approvals`,
 * `idle_close_minutes`, `program` and `gateway` alone. An agent the user added (`add_agent`) has no preset: its
 * `name`, `command`, `args` and `env` are changed themselves. Other fields are ignored, as in every request.
 */
export const AgentUpdateSchema = z.object({
  /** Only for an agent the user added: the others keep their product name. */
  name: AgentNameSchema.nullish(),
  enabled: z.boolean().nullish(),
  /** Turn AA's approvals on or off (agents whose preset has `approvals`; `failed_precondition` for others). */
  approvals: z.boolean().nullish(),
  /**
   * Minutes a conversation's agent may sit idle before it is closed (its next message starts it again, restoring its
   * context where the agent can); 0: never, the default.
   */
  idle_close_minutes: z.number().int().min(0).max(MAX_IDLE_CLOSE_MINUTES).nullish(),
  /**
   * Where the agent's program is, for one that is installed but not found (agents of the catalog; it must be there and
   * runnable); an empty string goes back to searching for it.
   */
  program: AgentProgramSchema.nullish(),
  /**
   * The model gateway to use. Its absent fields stay as they are, except the key when the address moves to another
   * host: it is never sent to one it was not entered for. An empty `base_url` removes the gateway.
   */
  gateway: z
    .object({ base_url: z.union([z.literal(""), GatewayUrlSchema]).nullish(), api_key: GatewayKeySchema.nullish(), model: GatewayModelSchema.nullish() })
    .nullish(),
  command: AgentCommandSchema.nullish(),
  args: AgentArgsSchema.nullish(),
  env: z
    .record(AgentEnvNameSchema, AgentEnvValueSchema.nullable())
    .refine((env) => Object.keys(env).length <= MAX_AGENT_ENV_VARS, `at most ${MAX_AGENT_ENV_VARS} environment variables`)
    .nullish(),
  reset: z.boolean().nullish(),
});

export interface AgentUpdate {
  name?: string | null;
  enabled?: boolean | null;
  approvals?: boolean | null;
  idle_close_minutes?: number | null;
  program?: string | null;
  gateway?: { base_url?: string | null; api_key?: string | null; model?: string | null } | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string | null> | null;
  reset?: boolean | null;
}

// ── Agents the user added (`aa.v3.Device/add_agent`) ────────────────────────────────────────────────────────────

/** What their ids start with: no agent the Connector brings along has such an id. */
export const CUSTOM_AGENT_ID_PREFIX = "custom-";
export const MAX_CUSTOM_AGENTS = 64;

/** A command of the user's that speaks ACP. Kept only on the device (`custom-agents.json`, 0600), like an override. */
export const CustomAgentSchema = z.object({
  id: AgentIdSchema.startsWith(CUSTOM_AGENT_ID_PREFIX),
  name: AgentNameSchema,
  command: AgentCommandSchema,
  args: AgentArgsSchema,
  env: AgentEnvSchema.optional(),
});
export interface CustomAgent {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
export const CustomAgentsSchema = z
  .array(CustomAgentSchema)
  .max(MAX_CUSTOM_AGENTS)
  .refine((agents) => new Set(agents.map((agent) => agent.id)).size === agents.length, "every agent needs an id of its own");

/** `add_agent`: the id is made from the name. */
export const NewAgentSchema = z.object({
  name: AgentNameSchema,
  command: AgentCommandSchema,
  args: AgentArgsSchema.nullish(),
  env: AgentEnvSchema.nullish(),
});
export interface NewAgent {
  name: string;
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
}

// ── The settings of each agent's newest conversation (`last-session-config.json`) ───────────────────────────────

/**
 * By agent id, the settings (model, mode, …: `config_id → value`) the agent's newest conversation on this device was
 * created with. The next conversation with that agent, and an agent prepared for one, starts with them wherever the
 * agent still offers the value: there is no separate "defaults" setting.
 */
export const LastSessionConfigSchema = z.record(AgentIdSchema, z.record(z.string().min(1).max(256), z.string().max(4096)));
export type LastSessionConfig = Record<string, Record<string, string>>;

// ── Compile-time agreement between the schemas and the interfaces above ─────────────────────────────────────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _ConfigSchemaChecks = [
  Assert<Same<z.infer<typeof DeviceSettingsSchema>, DeviceSettings>>,
  Assert<Same<z.infer<typeof PairedClientEntrySchema>, PairedClientEntry>>,
  Assert<Same<z.infer<typeof DeviceIdentitySchema>, DeviceIdentity>>,
  Assert<Same<z.infer<typeof AcpRuntimePresetSchema>, AcpRuntimePreset>>,
  Assert<Same<z.infer<typeof ModelGatewaySchema>, ModelGateway>>,
  Assert<Same<z.infer<typeof AgentOverrideSchema>, AgentOverride>>,
  Assert<Same<z.infer<typeof AgentOverridesSchema>, AgentOverrides>>,
  Assert<Same<z.infer<typeof AgentUpdateSchema>, AgentUpdate>>,
  Assert<Same<z.infer<typeof CustomAgentSchema>, CustomAgent>>,
  Assert<Same<z.infer<typeof NewAgentSchema>, NewAgent>>,
  Assert<Same<z.infer<typeof LastSessionConfigSchema>, LastSessionConfig>>,
];
