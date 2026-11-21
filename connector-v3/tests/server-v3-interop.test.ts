/**
 * Real cross-stack integration tests:
 *   1. Local-First mode: ConnectorHost + embedded LocalRouterHost (zero remote server), both normal and encrypted.
 *   2. Three-language full-stack interop:
 *        Go meshcall-router v0.4.0  <->  Python server-v3 (FastAPI + aa.v3.Control + /mcp)  <->  TypeScript connector-v3
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findRouterBinary,
  generateE2EKey,
  LocalRouter,
  Mesh,
  PermissionDeniedError,
  Router,
  UnauthenticatedError,
  type E2EIdentity,
} from "meshcall";

import { ConnectorHost, parsePairingUri, registerDeviceWithControlPlane } from "../src/index.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const SERVER_V3_DIR = path.join(REPO_ROOT, "server-v3");
const SERVER_V3_PYTHON = path.join(SERVER_V3_DIR, ".venv", "bin", "python");

function findRouterBin(): string | undefined {
  const env = process.env.MESHCALL_ROUTER_BINARY;
  if (env && existsSync(env)) return env;
  const sibling = path.resolve(REPO_ROOT, "..", "meshcall", "meshcall-router", "bin", "meshcall-router");
  if (existsSync(sibling)) return sibling;
  try {
    return findRouterBinary();
  } catch {
    return undefined;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function writeMockAcpAgent(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "mock-acp-agent.mjs");
  await writeFile(
    scriptPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let sidCounter = 0;
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "mock-acp", version: "1.0" } } });
    return;
  }
  if (msg.method === "session/new") {
    const sessionId = "acp_" + (++sidCounter);
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    const text = (msg.params.prompt || []).map((b) => b.text || "").join(" ");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACK:" + text } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`,
    "utf8",
  );
  return scriptPath;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
}

const ROUTER_BIN = findRouterBin();

test("local-first mode: embedded local meshcall-router works with zero remote server (normal + encrypted)", {
  timeout: 30_000,
  skip: ROUTER_BIN === undefined ? "meshcall-router binary not available" : false,
}, async (t) => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => undefined);
  });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aa-v3-local-first-"));
  cleanups.push(() => rm(tmpDir, { recursive: true, force: true }));
  const mockAgent = await writeMockAcpAgent(tmpDir);

  const host = new ConnectorHost({
    dataDir: path.join(tmpDir, "data"),
    localRouter: { binaryPath: ROUTER_BIN! },
    includeDefaultPresets: false,
    presets: [{ id: "mock", name: "Mock ACP", command: process.execPath, args: [mockAgent] }],
  });
  cleanups.push(() => host.stop());
  await host.start();

  assert.ok(host.localRouter);
  assert.ok(host.localRouterDescriptor?.url.startsWith("ws://127.0.0.1:"));

  // 1. Local client/SDK mints scoped token on local Router and runs an ACP turn with zero remote Server
  const localToken = await host.localRouter.issueLocalToken({ principal: "local:sdk" });
  const localClient = await Mesh.connect(new Router(host.localRouter.url), { token: localToken.token });
  cleanups.push(() => localClient.close());

  const status = await localClient.unary<object, { mode: string; runtimes: { id: string }[] }>(
    "aa.v3.Device",
    "status",
    {},
    { instance: host.deviceId },
  );
  assert.equal(status.mode, "normal");
  assert.equal(status.runtimes[0]?.id, "mock");

  const created = await localClient.unary<object, { id: string }>(
    "aa.v3.Sessions",
    "create",
    { agent: "mock", cwd: tmpDir, title: "Local Offline Chat" },
    { instance: host.deviceId },
  );
  const reply = await localClient.unary<object, { reply_text?: string }>(
    "aa.v3.Sessions",
    "send",
    { id: created.id, client_msg_id: "loc-1", content: "offline-hello", wait: true },
    { instance: host.deviceId },
  );
  assert.equal(reply.reply_text, "ACK:offline-hello");

  // 2. Switch local device to encrypted: direct local token is refused; local E2E tunnel + pairing works!
  await host.switchMode("encrypted");
  await assert.rejects(
    localClient.unary("aa.v3.Sessions", "list", {}, { instance: host.deviceId }),
    PermissionDeniedError,
  );

  const { uri } = await host.createPairing(60_000, { label: "Local Desktop", platform: "desktop" });
  const pairing = parsePairingUri(uri);
  const tunnel = await host.localRouter.openLocalTunnel({
    deviceId: host.deviceId,
    principal: "local:desktop",
    e2eKey: pairing.device_pub,
  });
  const desktopKeys = await generateE2EKey();
  const pairingId: E2EIdentity = {
    privateKey: desktopKeys.privateKey,
    instanceId: host.deviceId,
    pairing: { id: pairing.pairing_id, psk: pairing.psk },
  };
  const e2eMesh = await Mesh.connect(new Router(host.localRouter.url), {
    tunnel: tunnel.credential,
    e2eKey: pairing.device_pub,
    e2eIdentity: pairingId,
  });
  cleanups.push(() => e2eMesh.close());

  const listed = await e2eMesh.unary<object, { sessions: { id: string }[] }>(
    "aa.v3.Sessions",
    "list",
    {},
    { instance: host.deviceId },
  );
  assert.equal(listed.sessions[0]?.id, created.id);
});

const HAS_SERVER_V3 = existsSync(SERVER_V3_PYTHON);

test("three-language E2E: Go meshcall-router + Python server-v3 + TypeScript connector-v3 (presence, fanout, MCP, E2EE)", {
  timeout: 45_000,
  skip: !ROUTER_BIN ? "meshcall-router binary not available" : !HAS_SERVER_V3 ? "server-v3/.venv not installed" : false,
}, async (t) => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => undefined);
  });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aa-v3-interop-"));
  cleanups.push(() => rm(tmpDir, { recursive: true, force: true }));
  const mockAgent = await writeMockAcpAgent(tmpDir);

  // 1. Start real Go meshcall-router with control-plane issuer account only (no anonymous)
  const controlPw = "interop-control-secret-pw";
  const salt = randomBytes(16);
  const pwHash = `pbkdf2-sha256$600000$${salt.toString("hex")}$${pbkdf2Sync(controlPw, salt, 600_000, 32, "sha256").toString("hex")}`;
  const authFile = path.join(tmpDir, "router-auth.json");
  await writeFile(
    authFile,
    JSON.stringify({
      users: [
        {
          username: "control",
          password_hash: pwHash,
          roles: ["client", "server"],
          register: ["aa.v3.Control", "aa.v3.Sessions", "aa.v3.Terminals", "aa.v3.Device", "aa.v3.DeviceAdmin"],
          call: [
            "aa.v3.Control/*",
            "aa.v3.Sessions/*",
            "aa.v3.Terminals/*",
            "aa.v3.Device/*",
            "aa.v3.DeviceAdmin/*",
            "meshcall.router.v1.AuthService/*",
            "meshcall.router.v1.TunnelService/*",
            "meshcall.router.v1.Registry/*",
          ],
        },
      ],
    }),
    "utf8",
  );

  const router = await LocalRouter.start({ port: 0, authFile, binaryPath: ROUTER_BIN! });
  cleanups.push(() => router.close());

  // 2. Start real Python server-v3 connected to the Go Router (SQLite + FakeRedis in-process)
  const serverPort = await freePort();
  const controlUrl = `http://127.0.0.1:${serverPort}`;
  const serverLauncher = path.join(tmpDir, "run_server_v3.py");
  await writeFile(
    serverLauncher,
    `import asyncio, os, sys
import fakeredis.aioredis
import uvicorn
from aa_control.app import create_app
from aa_control.core.config import ControlSettings, RouterEndpoint
from aa_control.infra.db.engine import create_engine
from aa_control.infra.db.schema import metadata

async def main():
    engine = create_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
    redis = fakeredis.aioredis.FakeRedis(server=fakeredis.FakeServer())
    cfg = ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://127.0.0.1:6379/0",
        secret_key="interop-server-secret",
        public_origin=os.environ["CONTROL_ORIGIN"],
        routers=(RouterEndpoint(
            id="router-1",
            url=os.environ["ROUTER_URL"],
            public_url=os.environ["ROUTER_URL"],
            username="control",
            password=os.environ["CONTROL_PW"],
        ),),
        password_iterations=1000,
        fanout_timeout_seconds=5.0,
    )
    app = create_app(settings=cfg, engine=engine, redis_client=redis, start_push_worker=False)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(os.environ["SERVER_PORT"]), log_level="warning"))
    await server.serve()

asyncio.run(main())
`,
    "utf8",
  );

  const serverStderr: string[] = [];
  const serverProc: ChildProcess = spawn(SERVER_V3_PYTHON, [serverLauncher], {
    cwd: SERVER_V3_DIR,
    env: {
      ...process.env,
      PYTHONPATH: SERVER_V3_DIR,
      CONTROL_ORIGIN: controlUrl,
      ROUTER_URL: router.url,
      CONTROL_PW: controlPw,
      SERVER_PORT: String(serverPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serverProc.stderr?.on("data", (chunk: Buffer) => serverStderr.push(chunk.toString("utf8")));
  const serverClosed = new Promise<void>((resolve) => {
    serverProc.once("close", () => resolve());
  });
  cleanups.push(async () => {
    if (serverProc.exitCode === null) {
      serverProc.kill("SIGTERM");
      const exited = await Promise.race([serverClosed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
      if (!exited && serverProc.exitCode === null) {
        serverProc.kill("SIGKILL");
        await serverClosed;
      }
    }
  });

  await waitFor(async () => {
    if (serverProc.exitCode !== null) {
      throw new Error(`server-v3 exited early (${serverProc.exitCode}): ${serverStderr.join("")}`);
    }
    const res = await fetch(`${controlUrl}/readyz`);
    if (res.status === 200) return true;
    return undefined;
  }, 15_000);

  // 3. Register user & client Router token on Python server-v3
  const regRes = await fetch(`${controlUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "interop@example.com", password: "password123", display_name: "Interop" }),
  });
  assert.equal(regRes.status, 200, `server stderr: ${serverStderr.join("")}`);
  const userAuth = (await regRes.json()) as { access_token: string; user: { id: string } };
  const userHeaders = { Authorization: `Bearer ${userAuth.access_token}`, "Content-Type": "application/json" };

  const clientTokRes = await fetch(`${controlUrl}/auth/router-token`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ client_id: "cli_interop_1", platform: "desktop" }),
  });
  assert.equal(clientTokRes.status, 200);
  const clientRouterTok = ((await clientTokRes.json()) as { tokens: { token: string }[] }).tokens[0]!.token;

  // 4. Register device via connector-v3 control-client, then start TypeScript ConnectorHost in control-plane mode!
  const devKeys = await generateE2EKey();
  const registered = await registerDeviceWithControlPlane({
    controlUrl,
    accessToken: userAuth.access_token,
    name: "TS-Connector-Mac",
    platform: "macos",
    modeHint: "normal",
    connectorVersion: "3.0.0-alpha.1",
  });
  const connectorDataDir = path.join(tmpDir, "connector-data");
  const connector = new ConnectorHost({
    dataDir: connectorDataDir,
    controlUrl,
    deviceId: registered.device.id,
    deviceSecret: registered.device_secret,
    presenceIntervalMs: 2_000,
    includeDefaultPresets: false,
    presets: [{ id: "mock", name: "Mock ACP", command: process.execPath, args: [mockAgent] }],
  });
  await connector.init();
  cleanups.push(() => connector.stop());
  // Save device key so we know device pubkey deterministically (already auto-generated in init)
  const devPub = connector.gate.e2ePublicKey;
  assert.ok(devPub && devKeys.publicKey);
  await connector.start();

  // 5. Verify Python aa.v3.Control/list_devices sees TypeScript Connector online with live runtimes summary!
  const clientMesh = await Mesh.connect(new Router(router.url), { token: clientRouterTok });
  cleanups.push(() => clientMesh.close());

  const onlineDev = await waitFor(async () => {
    const res = await clientMesh.unary<object, { devices: Array<{ id: string; presence: string; summary?: { runtimes: string[] } }> }>(
      "aa.v3.Control",
      "list_devices",
      {},
    );
    const found = res.devices.find((d) => d.id === registered.device.id && d.presence === "online");
    return found;
  });
  assert.deepEqual(onlineDev.summary?.runtimes, ["mock"]);

  // 6. REAL MCP OAuth 2.1 + /mcp end-to-end across Python server-v3 -> Go Router -> TS connector-v3 -> stdio ACP!
  const dcr = (await (
    await fetch(`${controlUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Test MCP Agent", redirect_uris: ["http://127.0.0.1:9999/cb"] }),
    })
  ).json()) as { client_id: string };

  const verifier = "k".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const approved = (await (
    await fetch(`${controlUrl}/oauth/authorize`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        client_id: dcr.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        code_challenge: challenge,
        scopes: ["devices:read", "sessions:read", "sessions:write", "approvals:answer"],
        device_ids: [registered.device.id],
      }),
    })
  ).json()) as { code: string };

  const mcpTokBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: dcr.client_id,
    code: approved.code,
    redirect_uri: "http://127.0.0.1:9999/cb",
    code_verifier: verifier,
  });
  const mcpToken = ((await (await fetch(`${controlUrl}/oauth/token`, { method: "POST", body: mcpTokBody })).json()) as { access_token: string }).access_token;

  const mcpCall = async (name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${controlUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mcpToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(r.status, 200);
    return (await r.json()) as { result?: { isError: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] }; error?: { code: number; message: string } };
  };

  // With allow_mcp=false (default), TS connector refuses MCP!
  const blocked = await mcpCall("create_session", { device_id: registered.device.id, agent: "mock", cwd: tmpDir });
  assert.equal(blocked.result?.isError, true);

  // Enable allow_mcp on device -> full cross-language MCP call succeeds!
  await connector.setAllowMcp(true);
  const createdViaMcp = await mcpCall("create_session", { device_id: registered.device.id, agent: "mock", cwd: tmpDir, title: "MCP Session" });
  assert.equal(createdViaMcp.result?.isError, false);
  const sessionId = String(createdViaMcp.result?.structuredContent?.id);
  assert.ok(sessionId);

  const sentViaMcp = await mcpCall("send_message", {
    device_id: registered.device.id,
    session_id: sessionId,
    text: "hello-from-mcp",
    wait: true,
  });
  assert.equal(sentViaMcp.result?.isError, false);
  assert.equal(sentViaMcp.result?.structuredContent?.reply_text, "ACK:hello-from-mcp");

  // 7. Control plane fanout list_sessions_once hits TS connector-v3 over Go Router
  const fanout = await clientMesh.unary<object, { results: Array<{ device_id: string; status: string; value?: { sessions: { id: string }[] } }> }>(
    "aa.v3.Control",
    "list_sessions_once",
    {},
  );
  const normRes = fanout.results.find((r) => r.device_id === registered.device.id);
  assert.equal(normRes?.status, "ok");
  assert.equal(normRes?.value?.sessions[0]?.id, sessionId);

  // 8. Live switch to encrypted mode -> Python server-v3 strips summary, fanout returns "encrypted", MCP blocked, E2EE tunnel + Noise_IKpsk2/IK works!
  await connector.switchMode("encrypted");

  await waitFor(async () => {
    const res = await clientMesh.unary<object, { devices: Array<{ id: string; mode_hint: string; summary?: unknown }> }>(
      "aa.v3.Control",
      "list_devices",
      {},
    );
    const dev = res.devices.find((d) => d.id === registered.device.id);
    if (dev?.mode_hint === "encrypted" && dev.summary == null) return dev;
    return undefined;
  });

  const encFanout = await clientMesh.unary<object, { results: Array<{ device_id: string; status: string }> }>(
    "aa.v3.Control",
    "list_sessions_once",
    {},
  );
  assert.equal(encFanout.results.find((r) => r.device_id === registered.device.id)?.status, "encrypted");

  // MCP sees 0 devices and cannot call encrypted device
  const mcpDevices = await mcpCall("list_devices", {});
  assert.deepEqual(mcpDevices.result?.structuredContent?.devices, []);

  // Open real mtun_e2e. tunnel via Python aa.v3.Control/open_tunnel and pair via Noise_IKpsk2!
  const { uri } = await connector.createPairing(60_000, { label: "Interop iOS", platform: "ios" });
  const pairing = parsePairingUri(uri);
  const opened = await clientMesh.unary<object, { router_url: string; credential: string; mode: string }>(
    "aa.v3.Control",
    "open_tunnel",
    { device_id: registered.device.id, e2e_key: pairing.device_pub },
  );
  assert.equal(opened.mode, "encrypted");
  assert.ok(opened.credential.startsWith("mtun_e2e."));

  // Stranger rejected on handshake (first RPC call triggers Noise IK)
  const strangerKeys = await generateE2EKey();
  const strangerMesh = new Mesh(new Router(opened.router_url), {
    tunnel: opened.credential,
    e2eKey: pairing.device_pub,
    e2eIdentity: { privateKey: strangerKeys.privateKey, instanceId: registered.device.id },
  });
  try {
    await assert.rejects(
      strangerMesh.unary("aa.v3.Sessions", "list", {}, { instance: registered.device.id }),
      UnauthenticatedError,
    );
  } finally {
    await strangerMesh.close();
  }

  // Legitimate client pairs via Noise_IKpsk2, then reconnects via Noise_IK!
  const clientKeys = await generateE2EKey();
  const pairedMesh = new Mesh(new Router(opened.router_url), {
    tunnel: opened.credential,
    e2eKey: pairing.device_pub,
    e2eIdentity: {
      privateKey: clientKeys.privateKey,
      instanceId: registered.device.id,
      pairing: { id: pairing.pairing_id, psk: pairing.psk },
    },
  });
  try {
    const e2eList1 = await pairedMesh.unary<object, { sessions: { id: string }[] }>(
      "aa.v3.Sessions",
      "list",
      {},
      { instance: registered.device.id },
    );
    assert.equal(e2eList1.sessions[0]?.id, sessionId);
  } finally {
    await pairedMesh.close();
  }

  const ikMesh = new Mesh(new Router(opened.router_url), {
    tunnel: opened.credential,
    e2eKey: pairing.device_pub,
    e2eIdentity: { privateKey: clientKeys.privateKey, instanceId: registered.device.id },
  });
  try {
    const e2eList2 = await ikMesh.unary<object, { sessions: { id: string }[] }>(
      "aa.v3.Sessions",
      "list",
      {},
      { instance: registered.device.id },
    );
    assert.equal(e2eList2.sessions[0]?.id, sessionId);
  } finally {
    await ikMesh.close();
  }
});
