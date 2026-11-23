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
});

export interface AcpRuntimePreset {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ── Per-agent settings (`aa.v3.Device/update_agent`) ────────────────────────────────────────────────────────────

/** The names an agent's extra environment variables may have. */
export const AGENT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Extra environment variables one agent may have. */
export const MAX_AGENT_ENV_VARS = 128;

const noNul = (value: string): boolean => !value.includes("\u0000");
const NO_NUL = "must not contain NUL characters";

export const AgentIdSchema = z.string().min(1).max(64);
export const AgentNameSchema = z.string().trim().min(1).max(128);
export const AgentCommandSchema = z.string().trim().min(1).max(4096).refine(noNul, NO_NUL);
export const AgentArgsSchema = z.array(z.string().max(4096).refine(noNul, NO_NUL)).max(256);
export const AgentEnvNameSchema = z.string().max(256).regex(AGENT_ENV_NAME_PATTERN, "must match ^[A-Za-z_][A-Za-z0-9_]*$");
export const AgentEnvValueSchema = z.string().max(32_768).refine(noNul, NO_NUL);

/**
 * What this device changed about one agent against its preset: turned off, or another display name, command, args
 * or set of extra environment variables. `env`, when present, is the agent's whole set of extra variables (it takes
 * the place of the preset's). Kept only on the device (`agents.json`, 0600): the values of `env` never leave it.
 */
export const AgentOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  name: AgentNameSchema.optional(),
  command: AgentCommandSchema.optional(),
  args: AgentArgsSchema.optional(),
  env: z
    .record(AgentEnvNameSchema, AgentEnvValueSchema)
    .refine((env) => Object.keys(env).length <= MAX_AGENT_ENV_VARS, `at most ${MAX_AGENT_ENV_VARS} environment variables`)
    .optional(),
});

export interface AgentOverride {
  enabled?: boolean;
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Every agent's override, by agent id. */
export const AgentOverridesSchema = z.record(AgentIdSchema, AgentOverrideSchema);
export type AgentOverrides = Record<string, AgentOverride>;

/**
 * A change to one agent (`update_agent` without its `id`). Absent or `null` fields stay as they are; in `env` a
 * string sets the variable and `null` removes it. `reset` first drops the changes to the name, command, args and
 * environment (back to the preset), then applies the other fields; it leaves `enabled` alone.
 */
export const AgentUpdateSchema = z.object({
  enabled: z.boolean().nullish(),
  name: AgentNameSchema.nullish(),
  command: AgentCommandSchema.nullish(),
  args: AgentArgsSchema.nullish(),
  env: z
    .record(AgentEnvNameSchema, AgentEnvValueSchema.nullable())
    .refine((env) => Object.keys(env).length <= MAX_AGENT_ENV_VARS, `at most ${MAX_AGENT_ENV_VARS} environment variables`)
    .nullish(),
  reset: z.boolean().nullish(),
});

export interface AgentUpdate {
  enabled?: boolean | null;
  name?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string | null> | null;
  reset?: boolean | null;
}

// ── Compile-time agreement between the schemas and the interfaces above ─────────────────────────────────────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _ConfigSchemaChecks = [
  Assert<Same<z.infer<typeof DeviceSettingsSchema>, DeviceSettings>>,
  Assert<Same<z.infer<typeof PairedClientEntrySchema>, PairedClientEntry>>,
  Assert<Same<z.infer<typeof DeviceIdentitySchema>, DeviceIdentity>>,
  Assert<Same<z.infer<typeof AcpRuntimePresetSchema>, AcpRuntimePreset>>,
  Assert<Same<z.infer<typeof AgentOverrideSchema>, AgentOverride>>,
  Assert<Same<z.infer<typeof AgentOverridesSchema>, AgentOverrides>>,
  Assert<Same<z.infer<typeof AgentUpdateSchema>, AgentUpdate>>,
];
