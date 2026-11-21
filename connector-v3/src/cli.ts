#!/usr/bin/env node
/**
 * `aa-connector`: the v3 Connector command line.
 *
 *   aa-connector register --control-url URL --access-token TOKEN [--name NAME] [--mode normal|encrypted]
 *   aa-connector start    [--router URL[#TOKEN]]... [--presets FILE]
 *   aa-connector pair     [--ttl SECONDS] [--label LABEL] [--platform ios|android|desktop|web|cli]
 *   aa-connector mode     <normal|encrypted> [--yes]
 *   aa-connector mcp      <on|off>
 *   aa-connector clients
 *   aa-connector revoke   <client_pub>
 *   aa-connector status
 *
 * `start` serves until SIGINT / SIGTERM and listens on a local admin socket (inside the 0700 data directory, or a
 * 0600 socket in the temp directory when that path is too long). `pair` needs the running Connector: pairings live
 * only in its memory. The other commands use the running Connector when there is one and edit the state files
 * otherwise.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, unlink } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { AcpRuntimePresetSchema, ClientPlatformSchema, type AcpRuntimePreset, type ClientPlatform } from "./core/config.js";
import { CONNECTOR_VERSION, ConnectorHost, type ConnectorLogger, type RouterTarget } from "./host/connector-host.js";
import { registerDeviceWithControlPlane } from "./host/control-client.js";
import { devicePlatform } from "./runtime/device-ops.js";
import { defaultDataDir, StateStore, type DeviceMode } from "./runtime/state-store.js";
import { generateE2EKey } from "meshcall";

const USAGE = `aa-connector ${CONNECTOR_VERSION} — Agents Anywhere v3 Connector

Usage:
  aa-connector register    --control-url URL --access-token TOKEN [--name NAME] [--mode normal|encrypted] [--force]
  aa-connector start       [--local-router] [--local-router-port PORT] [--router URL[#TOKEN]]... [--presets FILE]
  aa-connector local-token [--principal NAME] [--ttl SECONDS]
  aa-connector pair        [--ttl SECONDS] [--label LABEL] [--platform ios|android|desktop|web|cli]
  aa-connector mode        <normal|encrypted> [--yes]
  aa-connector mcp         <on|off>
  aa-connector clients
  aa-connector revoke      <client_pub>
  aa-connector status

Common options:
  --data-dir DIR   state directory (default: $AA_CONNECTOR_DATA_DIR or ~/.agents-anywhere/connector-v3)

Environment:
  AA_CONNECTOR_DATA_DIR   state directory
  AA_CONTROL_URL          control plane URL for register
  AA_ACCESS_TOKEN         owner access token for register
  AA_ROUTER_URLS          comma-separated URL[#TOKEN] list for start (direct mode, no control plane)
  AA_CONNECTOR_PRESETS    JSON file with extra ACP runtime presets
  AA_LOG_LEVEL            info (default) | warn | error | silent
`;

class CliError extends Error {}

// ── Admin socket ────────────────────────────────────────────────────────────────────────────────────────────────

type AdminRequest =
  | { cmd: "status" }
  | { cmd: "pair"; ttl_ms?: number; label?: string; platform?: ClientPlatform }
  | { cmd: "local_token"; principal?: string; ttl_seconds?: number }
  | { cmd: "mode"; mode: DeviceMode }
  | { cmd: "mcp"; allow: boolean }
  | { cmd: "clients" }
  | { cmd: "revoke"; client_pub: string };

type AdminResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function adminSocketPath(dataDir: string): string {
  const hash = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\aa-connector-${hash}`;
  const inside = path.join(dataDir, "admin.sock");
  // sun_path is ~104 bytes on macOS, 108 on Linux.
  return Buffer.byteLength(inside) < 100 ? inside : path.join(os.tmpdir(), `aa-connector-${hash}.sock`);
}

async function handleAdmin(host: ConnectorHost, request: AdminRequest): Promise<unknown> {
  switch (request.cmd) {
    case "status":
      return {
        device_id: host.deviceId,
        mode: host.mode,
        serving: host.isServing,
        local_router: host.localRouterDescriptor ?? null,
        settings: host.settings,
        runtimes: host.runtimes.list(),
        paired_clients: host.listPairedClients().length,
        sessions: host.store.list().sessions.length,
      };
    case "local_token": {
      if (!host.localRouter) throw new CliError("local router is not enabled (start with --local-router)");
      const issued = await host.localRouter.issueLocalToken({
        ...(request.principal ? { principal: request.principal } : {}),
        ...(request.ttl_seconds ? { ttlSeconds: request.ttl_seconds } : {}),
      });
      return {
        router_url: host.localRouter.url,
        http_url: host.localRouter.httpUrl,
        device_id: host.deviceId,
        token: issued.token,
        token_id: issued.token_id,
        expires_at_unix_ms: issued.expires_at_unix_ms,
      };
    }
    case "pair": {
      const hint: { label?: string; platform?: ClientPlatform } = {};
      if (request.label) hint.label = request.label;
      if (request.platform) hint.platform = ClientPlatformSchema.parse(request.platform);
      const { uri, payload } = await host.createPairing(request.ttl_ms, hint);
      return { uri, expires_at: payload.expires_at, pairing_id: payload.pairing_id };
    }
    case "mode":
      await host.switchMode(request.mode);
      return { mode: host.mode };
    case "mcp":
      return host.setAllowMcp(request.allow);
    case "clients":
      return host.listPairedClients();
    case "revoke":
      return { revoked: host.revokePairedClient(request.client_pub) };
    default:
      throw new CliError(`unknown admin command ${(request as { cmd: string }).cmd}`);
  }
}

async function listenAdmin(host: ConnectorHost, socketPath: string, log: ConnectorLogger): Promise<net.Server> {
  if (process.platform !== "win32" && existsSync(socketPath)) {
    if (await adminCall(socketPath, { cmd: "status" }).then(() => true, () => false)) {
      throw new CliError(`another Connector is already running for this data directory (${socketPath})`);
    }
    await unlink(socketPath).catch(() => undefined);
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (buffer.length > 64 * 1024) socket.destroy();
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = "";
      void (async () => {
        let response: AdminResponse;
        try {
          response = { ok: true, result: await handleAdmin(host, JSON.parse(line) as AdminRequest) };
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
  log.info(`admin socket: ${socketPath}`);
  return server;
}

function adminCall(socketPath: string, request: AdminRequest, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CliError("the running Connector did not answer"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => (buffer += chunk));
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer) as AdminResponse;
        if (response.ok) resolve(response.result);
        else reject(new CliError(response.error));
      } catch {
        reject(new CliError("the running Connector sent an unreadable answer"));
      }
    });
  });
}

/** The running Connector's answer, or `undefined` when none is running. */
async function tryAdmin(dataDir: string, request: AdminRequest): Promise<{ result: unknown } | undefined> {
  try {
    return { result: await adminCall(adminSocketPath(dataDir), request) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
    throw error;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

function consoleLogger(): ConnectorLogger {
  const level = (process.env.AA_LOG_LEVEL ?? "info").toLowerCase();
  const rank = { info: 0, warn: 1, error: 2, silent: 3 }[level] ?? 0;
  const stamp = () => new Date().toISOString();
  return {
    info: (m) => rank <= 0 && console.log(`${stamp()} INFO  ${m}`),
    warn: (m) => rank <= 1 && console.warn(`${stamp()} WARN  ${m}`),
    error: (m) => rank <= 2 && console.error(`${stamp()} ERROR ${m}`),
  };
}

function parseRouters(values: string[]): RouterTarget[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v, i) => {
      const hash = v.indexOf("#");
      const url = hash < 0 ? v : v.slice(0, hash);
      const token = hash < 0 ? undefined : v.slice(hash + 1);
      return { id: `router-${i}`, url, ...(token ? { token } : {}) };
    });
}

async function loadPresets(file: string | undefined): Promise<AcpRuntimePreset[]> {
  if (!file) return [];
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new CliError(`${file} must hold a JSON array of presets`);
  return raw.map((entry) => AcpRuntimePresetSchema.parse(entry));
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────

async function cmdRegister(dataDir: string, values: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const controlUrl = (values["control-url"] as string | undefined) ?? process.env.AA_CONTROL_URL;
  const accessToken = (values["access-token"] as string | undefined) ?? process.env.AA_ACCESS_TOKEN;
  if (!controlUrl || !accessToken) throw new CliError("register needs --control-url and --access-token (or AA_CONTROL_URL / AA_ACCESS_TOKEN)");
  const mode = ((values.mode as string | undefined) ?? "normal") as DeviceMode;
  if (mode !== "normal" && mode !== "encrypted") throw new CliError("--mode is normal or encrypted");
  const state = new StateStore({ dataDir });
  const existing = await state.loadIdentity();
  if (existing && !values.force) throw new CliError(`already registered as ${existing.device_id}; pass --force to register again`);
  const settings = await state.loadSettings();
  const name = (values.name as string | undefined) ?? settings.device_name;
  const keys = existing?.e2e_private_key && existing.e2e_public_key ? { privateKey: existing.e2e_private_key, publicKey: existing.e2e_public_key } : await generateE2EKey();
  const registered = await registerDeviceWithControlPlane({
    controlUrl,
    accessToken,
    name,
    platform: devicePlatform(),
    modeHint: mode,
    connectorVersion: CONNECTOR_VERSION,
    ...(mode === "encrypted" ? { e2ePublicKeyHint: keys.publicKey } : {}),
  });
  await state.saveIdentity({
    device_id: registered.device.id,
    device_secret: registered.device_secret,
    control_url: controlUrl,
    e2e_private_key: keys.privateKey,
    e2e_public_key: keys.publicKey,
  });
  await state.updateSettings({ mode, device_name: registered.device.name });
  print(`registered device ${registered.device.id} ("${registered.device.name}", ${mode})`);
  if (registered.notice) print(registered.notice);
  print("run `aa-connector start` to connect");
}

async function cmdStart(dataDir: string, values: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const log = consoleLogger();
  const routerArgs = [...((values.router as string[] | undefined) ?? []), ...(process.env.AA_ROUTER_URLS ? [process.env.AA_ROUTER_URLS] : [])];
  const routers = routerArgs.length > 0 ? parseRouters(routerArgs) : undefined;
  const presets = await loadPresets((values.presets as string | undefined) ?? process.env.AA_CONNECTOR_PRESETS);
  const localRouterPort = values["local-router-port"] !== undefined ? Number(values["local-router-port"]) : undefined;
  if (localRouterPort !== undefined && (!Number.isInteger(localRouterPort) || localRouterPort < 0 || localRouterPort > 65535)) {
    throw new CliError("--local-router-port must be an integer 0..65535");
  }
  const useLocalRouter = Boolean(values["local-router"]) || localRouterPort !== undefined;
  const host = new ConnectorHost({
    dataDir,
    ...(routers ? { routers } : {}),
    ...(useLocalRouter ? { localRouter: localRouterPort !== undefined ? { port: localRouterPort } : true } : {}),
    presets,
    logger: log,
    onClientPaired: (entry) => log.info(`paired client ${entry.label} (${entry.platform}) ${entry.client_pub}`),
    onCheckUpdate: (channel) => log.info(`the control plane suggests checking for updates${channel ? ` (${channel})` : ""}; update with your package manager`),
    onModeChanged: (mode) => log.info(`mode switched to ${mode}`),
  });
  await host.init();
  const admin = await listenAdmin(host, adminSocketPath(dataDir), log);
  try {
    await host.start();
  } catch (error) {
    admin.close();
    throw error;
  }
  log.info(`device ${host.deviceId} serving in ${host.mode} mode; runtimes: ${host.runtimes.list().map((r) => r.id).join(", ") || "none"}`);
  if (host.mode === "encrypted" && host.listPairedClients().length === 0) log.info("no paired clients yet: run `aa-connector pair` on this device");

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  log.info("stopping…");
  admin.close();
  await host.stop();
  if (process.platform !== "win32") await unlink(adminSocketPath(dataDir)).catch(() => undefined);
}

async function cmdPair(dataDir: string, values: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const request: AdminRequest = { cmd: "pair" };
  if (values.ttl !== undefined) {
    const seconds = Number(values.ttl);
    if (!(seconds > 0)) throw new CliError("--ttl is a positive number of seconds");
    request.ttl_ms = Math.round(seconds * 1000);
  }
  if (typeof values.label === "string") request.label = values.label;
  if (typeof values.platform === "string") request.platform = ClientPlatformSchema.parse(values.platform);
  const answer = await tryAdmin(dataDir, request);
  if (answer === undefined) throw new CliError("no running Connector for this data directory: start it first (`aa-connector start`)");
  const result = answer.result as { uri: string; expires_at: string };
  print("Pairing link (show it only on this device; it carries the pairing secret and works once):\n");
  print(result.uri);
  print(`\nexpires at ${result.expires_at}`);
}

async function cmdMode(dataDir: string, positionals: string[], values: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const mode = positionals[0];
  if (mode !== "normal" && mode !== "encrypted") throw new CliError("usage: aa-connector mode <normal|encrypted>");
  const state = new StateStore({ dataDir });
  const current = (await state.loadSettings()).mode;
  if (mode === "normal" && current === "encrypted" && !values.yes) {
    throw new CliError("switching to normal lets the control plane server see this device's conversations and files. Re-run with --yes to confirm.");
  }
  const answer = await tryAdmin(dataDir, { cmd: "mode", mode });
  if (answer === undefined) await state.updateSettings({ mode });
  print(`mode: ${mode}${answer === undefined ? " (saved; applies when the Connector starts)" : " (connections were dropped and re-established under the new policy)"}`);
}

async function cmdMcp(dataDir: string, positionals: string[]): Promise<void> {
  const value = positionals[0];
  if (value !== "on" && value !== "off") throw new CliError("usage: aa-connector mcp <on|off>");
  const allow = value === "on";
  const answer = await tryAdmin(dataDir, { cmd: "mcp", allow });
  if (answer === undefined) await new StateStore({ dataDir }).updateSettings({ allow_mcp: allow });
  print(`external agent (MCP) control: ${value}`);
}

async function cmdClients(dataDir: string): Promise<void> {
  const answer = await tryAdmin(dataDir, { cmd: "clients" });
  const clients = answer === undefined ? await new StateStore({ dataDir }).loadPairedClients() : answer.result;
  print(clients);
}

async function cmdRevoke(dataDir: string, positionals: string[]): Promise<void> {
  const clientPub = positionals[0];
  if (!clientPub) throw new CliError("usage: aa-connector revoke <client_pub>");
  const answer = await tryAdmin(dataDir, { cmd: "revoke", client_pub: clientPub });
  let revoked: boolean;
  if (answer === undefined) {
    const state = new StateStore({ dataDir });
    const clients = await state.loadPairedClients();
    const remaining = clients.filter((c) => c.client_pub !== clientPub);
    revoked = remaining.length !== clients.length;
    if (revoked) await state.savePairedClients(remaining);
  } else {
    revoked = (answer.result as { revoked: boolean }).revoked;
  }
  print(revoked ? `revoked ${clientPub}` : `no paired client ${clientPub}`);
  if (!revoked) process.exitCode = 1;
}

async function cmdStatus(dataDir: string): Promise<void> {
  const answer = await tryAdmin(dataDir, { cmd: "status" });
  if (answer !== undefined) {
    print(answer.result);
    return;
  }
  const state = new StateStore({ dataDir });
  const identity = await state.loadIdentity();
  print({ running: false, device_id: identity?.device_id ?? null, settings: await state.loadSettings() });
}

async function cmdLocalToken(dataDir: string, values: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const request: AdminRequest = { cmd: "local_token" };
  if (values.principal) request.principal = String(values.principal);
  if (values.ttl !== undefined) {
    const seconds = Number(values.ttl);
    if (!(seconds > 0)) throw new CliError("--ttl is a positive number of seconds");
    request.ttl_seconds = Math.round(seconds);
  }
  const answer = await tryAdmin(dataDir, request);
  if (answer === undefined) throw new CliError("no Connector is running for this data directory; run `aa-connector start --local-router` first");
  print(answer.result);
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      "control-url": { type: "string" },
      "access-token": { type: "string" },
      "local-router": { type: "boolean" },
      "local-router-port": { type: "string" },
      principal: { type: "string" },
      name: { type: "string" },
      mode: { type: "string" },
      force: { type: "boolean" },
      router: { type: "string", multiple: true },
      presets: { type: "string" },
      ttl: { type: "string" },
      label: { type: "string" },
      platform: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return print(CONNECTOR_VERSION);
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") return print(USAGE);
  const dataDir = path.resolve((values["data-dir"] as string | undefined) ?? process.env.AA_CONNECTOR_DATA_DIR ?? defaultDataDir());
  switch (command) {
    case "register":
      return cmdRegister(dataDir, values);
    case "start":
      return cmdStart(dataDir, values);
    case "local-token":
      return cmdLocalToken(dataDir, values);
    case "pair":
      return cmdPair(dataDir, values);
    case "mode":
      return cmdMode(dataDir, rest, values);
    case "mcp":
      return cmdMcp(dataDir, rest);
    case "clients":
      return cmdClients(dataDir);
    case "revoke":
      return cmdRevoke(dataDir, rest);
    case "status":
      return cmdStatus(dataDir);
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  () => {
    // `start` returns after a clean stop; anything left (agents, sockets) must not keep the process alive.
    if (process.argv[2] === "start") process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => {
    console.error(error instanceof CliError || error instanceof Error ? `aa-connector: ${error.message}` : error);
    process.exit(1);
  },
);
