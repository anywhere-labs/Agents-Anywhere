// End-to-end: one `ConnectorHost` serving the same device on several real Go `meshcall-router` processes at once.
// The control plane registers a device on every Router it runs (architecture §7), so a client may reach the device
// through any of them. These tests pin what that promises: one shared device state behind every Router, a Router
// going away does not take the device down on the others, a restarted Router gets the device back, and startup
// succeeds while some Routers are unreachable.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findRouterBinary, LocalRouter, Mesh, Router } from "meshcall";

import { ConnectorHost } from "../src/host/connector-host.js";
import type { Message, Session, WatchEvent } from "../src/core/timeline.js";

const CONNECTOR_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function routerBinary(): string | undefined {
  const candidates = [process.env.MESHCALL_ROUTER_BINARY, path.resolve(CONNECTOR_ROOT, "../../meshcall/meshcall-router/bin/meshcall-router")];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  try {
    return findRouterBinary();
  } catch {
    return undefined;
  }
}

const ROUTER_BINARY = routerBinary();
const SKIP = ROUTER_BINARY === undefined ? "meshcall-router binary not found (set MESHCALL_ROUTER_BINARY)" : false;

// A minimal stdio ACP agent: answers every prompt with "echo: <text>".
const ECHO_AGENT = String.raw`
let n = 0;
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
function handle({ id, method, params }) {
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "echo-agent", version: "1.0.0" } });
    case "session/new":
      return reply({ sessionId: "acp-" + ++n });
    case "session/cancel":
      return;
    case "session/prompt": {
      const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " + text } } } });
      return reply({ stopReason: "end_turn" });
    }
    default:
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: "no " + method } });
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const SCOPES = ["aa.v3.Sessions", "aa.v3.Device", "aa.v3.Terminals"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? "" : `: ${String(last)}`}`);
    await sleep(50);
  }
}

/** A port nothing listens on: bind an ephemeral one, then release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

/** Collects the finished assistant texts of one `watch` stream. */
class Watcher {
  readonly messages = new Map<string, Message>();
  ended = false;

  constructor(stream: AsyncIterable<WatchEvent>) {
    void (async () => {
      try {
        for await (const event of stream) {
          if (event.type === "snapshot") {
            this.messages.clear();
            for (const m of event.messages) this.messages.set(m.id, m);
          } else if (event.type === "message") this.messages.set(event.message.id, event.message);
        }
      } catch {
        // A Router going away ends the stream with an error; `ended` is what the tests look at.
      } finally {
        this.ended = true;
      }
    })();
  }

  texts(): string[] {
    return [...this.messages.values()]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((m) => (m.role === "assistant" && m.parts[0]?.type === "text" && m.done ? [m.parts[0].text] : []));
  }
}

describe("ConnectorHost on several meshcall-routers", { skip: SKIP, timeout: 120_000 }, () => {
  let tmp: string;
  let agentScript: string;
  let workDir: string;
  const routers: LocalRouter[] = [];
  const meshes: Mesh[] = [];
  const hosts: ConnectorHost[] = [];

  async function startRouter(port = 0): Promise<LocalRouter> {
    const router = await LocalRouter.start({ port, binaryPath: ROUTER_BINARY as string });
    routers.push(router);
    return router;
  }

  async function startHost(deviceId: string, urls: string[]): Promise<ConnectorHost> {
    const host = new ConnectorHost({
      dataDir: path.join(tmp, deviceId),
      deviceId,
      routers: urls.map((url, i) => ({ id: `router-${i}`, url })),
      presets: [{ id: "echo", name: "Echo ACP", command: process.execPath, args: [agentScript] }],
      includeDefaultPresets: false,
      waitTimeoutMs: 10_000,
    });
    hosts.push(host);
    await host.start();
    return host;
  }

  /** The control plane's account on one Router (these test Routers run without an auth file). */
  async function controlOn(router: LocalRouter): Promise<Mesh> {
    const mesh = await Mesh.connect(new Router(router.url));
    meshes.push(mesh);
    return mesh;
  }

  /** A client reaching `deviceId` through a plain tunnel opened on `router`. */
  async function tunnelOn(router: LocalRouter, deviceId: string): Promise<Mesh> {
    const control = await controlOn(router);
    const opened = await control.tunnels.open({ instance: deviceId, scopes: SCOPES, principal: "user:u1/client:test" });
    const mesh = await Mesh.connect(new Router(router.url), { tunnel: opened.credential });
    meshes.push(mesh);
    return mesh;
  }

  const ping = (control: Mesh, deviceId: string) =>
    control.unary<object, { device_id?: string }>("aa.v3.DeviceAdmin", "ping", {}, { instance: deviceId, timeoutMs: 3_000 });

  const listIds = async (client: Mesh, deviceId: string) =>
    (await client.unary<object, { sessions: { id: string }[] }>("aa.v3.Sessions", "list", {}, { instance: deviceId, timeoutMs: 5_000 }))
      .sessions.map((s) => s.id);

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "aa-connector-multi-router-"));
    workDir = path.join(tmp, "project");
    await mkdir(workDir, { recursive: true });
    agentScript = path.join(tmp, "echo-acp-agent.cjs");
    await writeFile(agentScript, ECHO_AGENT);
  });

  after(async () => {
    for (const mesh of meshes.reverse()) await mesh.close().catch(() => undefined);
    for (const host of hosts) await host.stop().catch(() => undefined);
    for (const router of routers) await router.close().catch(() => undefined);
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("serves one shared device state behind every Router, and survives losing one of them", async () => {
    const r1 = await startRouter();
    const r2 = await startRouter();
    const host = await startHost("dev-multi", [r1.url, r2.url]);
    const deviceId = host.deviceId;

    // The content-free admin service answers the control plane on both Routers.
    await ping(await controlOn(r1), deviceId);
    await ping(await controlOn(r2), deviceId);

    // A session created through Router 1 is the same session seen through Router 2.
    const viaR1 = await tunnelOn(r1, deviceId);
    const viaR2 = await tunnelOn(r2, deviceId);
    const created = await viaR1.unary<object, Session>("aa.v3.Sessions", "create", { agent: "echo", title: "Multi", cwd: workDir }, { instance: deviceId });
    assert.deepEqual(await listIds(viaR2, deviceId), [created.id]);

    // A watcher on each Router sees a turn sent through Router 1.
    const watch1 = new Watcher(viaR1.serverStream<object, WatchEvent>("aa.v3.Sessions", "watch", { id: created.id }, { instance: deviceId }));
    const watch2 = new Watcher(viaR2.serverStream<object, WatchEvent>("aa.v3.Sessions", "watch", { id: created.id }, { instance: deviceId }));
    await viaR1.unary("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m1", content: "one" }, { instance: deviceId });
    await eventually(() => (watch1.texts().includes("echo: one") && watch2.texts().includes("echo: one") ? true : undefined), "both watchers see the reply");

    // `client_msg_id` deduplicates across Routers: a client that retries on another Router does not send twice.
    const first = await viaR2.unary<object, { message_id: string }>("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m2", content: "two" }, { instance: deviceId });
    const retry = await viaR1.unary<object, { message_id: string }>("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m2", content: "two" }, { instance: deviceId });
    assert.equal(retry.message_id, first.message_id);
    await eventually(() => (watch2.texts().filter((t) => t === "echo: two").length === 1 ? true : undefined), "one reply to the deduplicated send");

    // Router 1 goes away: its watcher ends, Router 2 keeps serving the device without a restart.
    await r1.close();
    await eventually(() => (watch1.ended ? true : undefined), "the watch on the closed Router ends");
    assert.equal(watch2.ended, false);
    await viaR2.unary("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m3", content: "three" }, { instance: deviceId });
    await eventually(() => (watch2.texts().includes("echo: three") ? true : undefined), "Router 2 still carries the turn");
    assert.deepEqual(await listIds(viaR2, deviceId), [created.id]);
  });

  it("registers again on a Router that restarts", async () => {
    const r1 = await startRouter();
    const r2 = await startRouter();
    const host = await startHost("dev-restart", [r1.url, r2.url]);
    const deviceId = host.deviceId;
    const port = portOf(r1.url);

    await r1.close();
    // Router 2 is unaffected while Router 1 is down.
    await ping(await controlOn(r2), deviceId);

    // A fresh Router process on the same address knows nothing; the device's reconnect loop registers it again.
    const restarted = await startRouter(port);
    const control = await controlOn(restarted);
    await eventually(async () => (await ping(control, deviceId)) ?? true, "the device back on the restarted Router", 30_000);
    const client = await tunnelOn(restarted, deviceId);
    assert.ok(Array.isArray(await listIds(client, deviceId)));
  });

  it("starts while some of its Routers are unreachable", async () => {
    const live = await startRouter();
    const dead = `ws://127.0.0.1:${await closedPort()}`;

    const started = Date.now();
    const host = await startHost("dev-partial", [dead, live.url]);
    assert.ok(Date.now() - started < 30_000, "start does not wait on the unreachable Router");

    const client = await tunnelOn(live, host.deviceId);
    assert.deepEqual(await listIds(client, host.deviceId), []);
  });

  it("registers on a Router that was down at startup once it comes up", async () => {
    const live = await startRouter();
    const latePort = await closedPort();
    const host = await startHost("dev-late", [`ws://127.0.0.1:${latePort}`, live.url]);

    const late = await startRouter(latePort);
    const control = await controlOn(late);
    await eventually(async () => (await ping(control, host.deviceId)) ?? true, "the device on the Router that came up late", 30_000);
  });

  it("drops pending retries when it stops", async () => {
    const live = await startRouter();
    const latePort = await closedPort();
    const host = await startHost("dev-stopped", [`ws://127.0.0.1:${latePort}`, live.url]);
    await host.stop();

    // The first retries are due within a few seconds; a stopped host must not answer any of them.
    const late = await startRouter(latePort);
    await sleep(4_000);
    const control = await controlOn(late);
    await assert.rejects(ping(control, host.deviceId), /No instances registered/);
  });

  it("fails to start when no Router is reachable", async () => {
    const dead = [`ws://127.0.0.1:${await closedPort()}`, `ws://127.0.0.1:${await closedPort()}`];
    const host = new ConnectorHost({
      dataDir: path.join(tmp, "dev-none"),
      deviceId: "dev-none",
      routers: dead.map((url, i) => ({ id: `router-${i}`, url })),
      presets: [{ id: "echo", name: "Echo ACP", command: process.execPath, args: [agentScript] }],
      includeDefaultPresets: false,
    });
    hosts.push(host);
    await assert.rejects(host.start());
  });
});
