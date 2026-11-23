// End-to-end: a real Go `meshcall-router` (v0.4.0), a real `ConnectorHost`, and a real stdio ACP agent (a tiny
// Node script speaking JSON-RPC 2.0) — the control plane, plain tunnels, MCP, the safe mode switch, and
// encrypted-mode pairing with Noise_IKpsk2 / Noise_IK.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  findRouterBinary,
  generateE2EKey,
  LocalRouter,
  Mesh,
  MeshCallError,
  method,
  PermissionDeniedError,
  Router,
  service,
  UnauthenticatedError,
  z,
  type E2EKeyPair,
  type RpcContext,
} from "meshcall";

import { ControlPresenceClient, type PresenceReport } from "../src/host/control-client.js";
import { ConnectorHost } from "../src/host/connector-host.js";
import { PAIRING_CODE_ID, derivePairingCodePsk } from "../src/core/gate.js";
import type { Control, Message, Session, SessionListEvent, WatchEvent } from "../src/core/timeline.js";

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const CONNECTOR_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTROL_SCHEMA_URL = new URL("../../../contracts/aa-v3/1.0/control.schema.json", import.meta.url);
const TERMINALS_SCHEMA_URL = new URL("../../../contracts/aa-v3/1.0/terminals.schema.json", import.meta.url);

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
const IS_WINDOWS = process.platform === "win32";

// ── Mock ACP agent ──────────────────────────────────────────────────────────────────────────────────────────────

const MOCK_AGENT = String.raw`
const sessions = new Map();
const pending = new Map();
let nextId = 1000;
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
// One message in two writes: the host must reassemble partial lines.
const outSplit = (msg) => new Promise((resolve) => {
  const line = JSON.stringify(msg) + "\n";
  const cut = Math.floor(line.length / 2);
  process.stdout.write(line.slice(0, cut));
  setTimeout(() => { process.stdout.write(line.slice(cut)); resolve(); }, 5);
});
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const request = (method, params) => { const id = nextId++; out({ jsonrpc: "2.0", id, method, params }); return new Promise((r) => pending.set(id, r)); };
const config = (model) => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
  options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }] }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(msg) {
  if (msg.method === undefined) { const r = pending.get(msg.id); pending.delete(msg.id); r && r(msg); return; }
  const { id, method, params } = msg;
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "mock-agent", version: "1.0.0" } });
    case "session/new": {
      const sessionId = "acp-" + (sessions.size + 1);
      sessions.set(sessionId, { model: "fast", cancelled: false, cwd: params.cwd });
      return reply({ sessionId, configOptions: config("fast") });
    }
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      s.model = params.value;
      return reply({ configOptions: config(s.model) });
    }
    case "session/cancel": { const s = sessions.get(params.sessionId); if (s) s.cancelled = true; return; }
    case "session/prompt": {
      const sid = params.sessionId;
      const s = sessions.get(sid);
      s.cancelled = false;
      const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text.includes("permission")) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "t-" + id, title: "Run rm -rf build", kind: "execute", status: "pending" });
        const res = await request("session/request_permission", {
          sessionId: sid, toolCall: { toolCallId: "t-" + id, title: "Run rm -rf build" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
        });
        const outcome = res.result.outcome;
        if (outcome.outcome === "cancelled") return reply({ stopReason: "cancelled" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-" + id, status: "completed" });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission:" + outcome.optionId } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.startsWith("read ")) {
        const res = await request("fs/read_text_file", { sessionId: sid, path: text.slice(5).trim() });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: res.error ? "error:" + res.error.message : "file:" + res.result.content } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.includes("slow")) {
        for (let i = 0; i < 100; i++) { if (s.cancelled) return reply({ stopReason: "cancelled" }); await sleep(30); }
      }
      await outSplit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " } } } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
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
    if (line.trim()) handle(JSON.parse(line)).catch((e) => process.stderr.write(String(e) + "\n"));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

// ── Fake control plane service (records what the Connector reports) ────────────────────────────────────────────

const PresenceItem = z.looseObject({ device_id: z.string(), mode_hint: z.string() });
const PushRequest = z.looseObject({ device_id: z.string(), event_type: z.string() });
const received: { presence: Record<string, unknown>[]; pushes: Record<string, unknown>[] } = { presence: [], pushes: [] };

@service("aa.v3.Control", { description: "Test double of the control plane's Connector-facing methods." })
class FakeControl {
  @method.clientStream({ description: "presence", request: z.object({}), inputItem: PresenceItem, response: z.object({ accepted: z.number() }) })
  async presence(_req: unknown, items: AsyncIterable<z.output<typeof PresenceItem>>, _ctx: RpcContext) {
    let accepted = 0;
    for await (const item of items) {
      received.presence.push(item);
      accepted++;
    }
    return { accepted };
  }

  @method({ description: "notify_push", request: PushRequest, response: z.object({ queued: z.number(), content_stripped: z.boolean() }) })
  notify_push(req: z.output<typeof PushRequest>, _ctx: RpcContext) {
    received.pushes.push(req);
    return { queued: 1, content_stripped: false };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

function reasonOf(error: unknown): string | undefined {
  return error instanceof MeshCallError ? error.reason : undefined;
}

async function eventually<T>(read: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Consumes `aa.v3.Sessions/watch` and keeps the client-side view: replace by id, a snapshot replaces all. */
class SessionView {
  session: Session | undefined;
  control: Control | undefined;
  readonly messages = new Map<string, Message>();
  ended = false;
  error: unknown;

  constructor(stream: AsyncIterable<WatchEvent>) {
    void (async () => {
      try {
        for await (const event of stream) this.apply(event);
      } catch (error) {
        this.error = error;
      } finally {
        this.ended = true;
      }
    })();
  }

  apply(event: WatchEvent): void {
    if (event.type === "snapshot") {
      this.session = event.session;
      this.control = event.control;
      this.messages.clear();
      for (const m of event.messages) this.messages.set(m.id, m);
    } else if (event.type === "message") this.messages.set(event.message.id, event.message);
    else if (event.type === "session") this.session = event.session;
    else this.control = event.control;
  }

  texts(): string[] {
    return [...this.messages.values()]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((m) => (m.role === "assistant" && m.parts[0].type === "text" && m.done ? [m.parts[0].text] : []));
  }

  idle(): boolean {
    return this.control?.state === "idle" && this.control.pending.length === 0;
  }

  until(predicate: (view: this) => boolean, what: string, timeoutMs = 10_000): Promise<true> {
    return eventually(() => (predicate(this) ? true : undefined), what, timeoutMs);
  }
}

interface TerminalInfoWire {
  id: string;
  mode: string;
  cols: number;
  rows: number;
  viewers: number;
  generation: number;
  controller: { client_id: string; label: string; connected: boolean } | null;
}

interface TerminalFrame {
  type: "snapshot" | "output" | "control" | "rejected" | "exit";
  data?: string;
  seq?: number;
  cols?: number;
  rows?: number;
  generation?: number;
  you?: boolean;
  controller?: { client_id: string; label: string; connected: boolean } | null;
  reason?: string;
  exit_code?: number | null;
}

/** Client side of `aa.v3.Terminals/attach`: reads frames in the background (as a real client must), validating each. */
class TerminalStream {
  readonly seen: TerminalFrame[] = [];
  /** Output text of the frames consumed so far. */
  text = "";
  /** Seq of the last output frame received. */
  lastSeq = 0;
  ended = false;
  error: unknown;
  #read = 0;

  constructor(
    readonly call: { send(item: unknown): Promise<void>; cancel(reason?: string): Promise<void> } & AsyncIterable<TerminalFrame>,
    check: (frame: TerminalFrame) => void,
  ) {
    void (async () => {
      try {
        for await (const frame of call) {
          check(frame);
          if (frame.type === "output") this.lastSeq = frame.seq ?? this.lastSeq;
          this.seen.push(frame);
        }
      } catch (error) {
        this.error = error;
      } finally {
        this.ended = true;
      }
    })();
  }

  /** The next frame not yet consumed by next() / until(). */
  async next(): Promise<TerminalFrame> {
    const frame = await eventually(() => this.seen[this.#read] ?? (this.ended ? null : undefined), "next terminal frame");
    if (frame === null) throw new Error(`terminal stream ended: ${String(this.error)}`);
    this.#read++;
    // Text grows only with consumed frames, so untilText never skips past a later frame.
    if (frame.type === "output" && frame.data) this.text += Buffer.from(frame.data, "base64").toString("utf8");
    return frame;
  }

  async until(match: (frame: TerminalFrame) => boolean, what: string): Promise<TerminalFrame> {
    for (;;) {
      const frame = await this.next().catch((error: unknown) => {
        throw new Error(`${what}: ${String(error)}`);
      });
      if (match(frame)) return frame;
    }
  }

  /** Consume frames until the consumed output matches (no-op when it already does). */
  async untilText(pattern: RegExp): Promise<void> {
    if (!pattern.test(this.text)) await this.until(() => pattern.test(this.text), `output ${pattern}`);
  }

  control(predicate: (frame: TerminalFrame) => boolean = () => true): Promise<TerminalFrame> {
    return this.until((f) => f.type === "control" && predicate(f), "control frame");
  }

  rejected(): Promise<TerminalFrame> {
    return this.until((f) => f.type === "rejected", "rejected frame");
  }
}

// ── The test ────────────────────────────────────────────────────────────────────────────────────────────────────

const SCOPES = ["aa.v3.Sessions", "aa.v3.Device", "aa.v3.Terminals"];

describe("ConnectorHost against a real meshcall-router", { skip: SKIP, timeout: 120_000 }, () => {
  let router: LocalRouter;
  let routerUrl: Router;
  let host: ConnectorHost;
  let control: Mesh;
  let controlHost: { close(): Promise<void> } | undefined;
  let tmp: string;
  let workDir: string;
  let deviceId: string;
  const cleanup: Mesh[] = [];
  const validators: Record<string, ReturnType<InstanceType<typeof Ajv2020>["getSchema"]>> = {};

  const direct = (via: string, extra: Record<string, string> = {}) => ({
    instance: deviceId,
    timeoutMs: 15_000,
    metadata: { "aa-via": via, "aa-on-behalf-of": "user:u1", ...extra },
  });

  function validate(def: string, value: unknown): void {
    const check = validators[def];
    assert.ok(check, `schema ${def}`);
    assert.ok(check(value), `${def}: ${JSON.stringify(check.errors)}`);
  }

  async function tunnelClient(principal = "user:u1/client:web"): Promise<{ mesh: Mesh; tunnelId: string }> {
    const opened = await control.tunnels.open({ instance: deviceId, scopes: SCOPES, principal });
    const mesh = await Mesh.connect(routerUrl, { tunnel: opened.credential });
    cleanup.push(mesh);
    return { mesh, tunnelId: opened.tunnel_id };
  }

  before(async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const contracts: [URL, string[]][] = [
      [CONTROL_SCHEMA_URL, ["SessionListPayload", "DeviceAdminPingResponse", "PresenceReport", "PushNotificationRequest"]],
      [TERMINALS_SCHEMA_URL, ["TerminalInfo", "AttachRequest", "TerminalInputFrame", "TerminalOutputFrame"]],
    ];
    for (const [url, defs] of contracts) {
      const schema = JSON.parse(await readFile(url, "utf8")) as { $id: string };
      ajv.addSchema(schema);
      for (const def of defs) validators[def] = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
    }

    tmp = await mkdtemp(path.join(os.tmpdir(), "aa-connector-e2e-"));
    workDir = path.join(tmp, "project");
    await rm(workDir, { recursive: true, force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(workDir, { recursive: true }));
    await writeFile(path.join(workDir, "notes.txt"), "hello from disk");
    const agentScript = path.join(tmp, "mock-acp-agent.cjs");
    await writeFile(agentScript, MOCK_AGENT);

    router = await LocalRouter.start({ port: 0, binaryPath: ROUTER_BINARY as string });
    routerUrl = new Router(router.url);
    host = new ConnectorHost({
      dataDir: path.join(tmp, "state"),
      deviceId: "dev-e2e",
      routers: [{ url: router.url }],
      presets: [{ id: "mock", name: "Mock ACP", command: process.execPath, args: [agentScript] }],
      includeDefaultPresets: false,
      waitTimeoutMs: 10_000,
    });
    await host.start();
    deviceId = host.deviceId;
    control = await Mesh.connect(routerUrl);
    cleanup.push(control);
  });

  after(async () => {
    for (const mesh of cleanup.reverse()) await mesh.close().catch(() => undefined);
    await controlHost?.close().catch(() => undefined);
    await host?.stop().catch(() => undefined);
    await router?.close().catch(() => undefined);
    // maxRetries: a debounced state write (e.g. after the revocation above) may land while the directory is removed.
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("normal mode: control plane, MCP policy, tunnel sessions with a real ACP agent", async () => {
    // Control plane (aa-via: client) reaches Sessions/list directly; the answer fits server-v3's SessionListPayload.
    const listed = await control.unary("aa.v3.Sessions", "list", {}, direct("client"));
    assert.deepEqual(listed, { sessions: [], projects: [] });
    validate("SessionListPayload", listed);
    // server-v3 sends `limit` (limit_per_device) the same way.
    validate("SessionListPayload", await control.unary("aa.v3.Sessions", "list", { limit: 5 }, direct("client")));

    const ping = await control.unary("aa.v3.DeviceAdmin", "ping", {}, { instance: deviceId });
    validate("DeviceAdminPingResponse", ping);

    // MCP is off by default.
    const denied = await rejection(control.unary("aa.v3.Sessions", "list", {}, direct("mcp", { "aa-mcp-client": "Claude" })));
    assert.ok(denied instanceof PermissionDeniedError, String(denied));
    assert.equal(reasonOf(denied), "mcp_disabled_on_device");
    await host.setAllowMcp(true);
    assert.deepEqual(await control.unary("aa.v3.Sessions", "list", {}, direct("mcp", { "aa-mcp-client": "Claude" })), { sessions: [], projects: [] });

    // A client through a plain tunnel.
    const { mesh: client, tunnelId } = await tunnelClient();
    const created = await client.unary<object, Session>("aa.v3.Sessions", "create", { agent: "mock", title: "E2E", cwd: workDir }, { instance: deviceId });
    assert.equal(created.agent, "mock");
    assert.equal(created.cwd, workDir);
    assert.equal(created.config[0]?.current, "fast");
    const unknownAgent = await rejection(client.unary("aa.v3.Sessions", "create", { agent: "nope" }, { instance: deviceId }));
    assert.equal(reasonOf(unknownAgent), "unknown_agent");

    const configured = await client.unary<object, Session>("aa.v3.Sessions", "set_config", { id: created.id, config_id: "model", value: "smart" }, { instance: deviceId });
    assert.equal(configured.config[0]?.current, "smart");

    const view = new SessionView(client.serverStream<object, WatchEvent>("aa.v3.Sessions", "watch", { id: created.id }, { instance: deviceId }));
    await view.until((v) => v.session !== undefined, "watch snapshot");

    // send → started → the agent's echo (its first chunk arrives on stdout in two pieces).
    const sent = await client.unary<object, { message_id: string; delivered: string; session_id: string }>(
      "aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m1", content: "hello" }, { instance: deviceId });
    assert.equal(sent.delivered, "started");
    assert.equal(sent.session_id, created.id);
    await view.until((v) => v.texts().includes("echo: hello") && v.idle(), "echo reply");
    // Idempotent on client_msg_id.
    const again = await client.unary<object, { message_id: string }>("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m1", content: "hello" }, { instance: deviceId });
    assert.equal(again.message_id, sent.message_id);

    // Permission: the agent asks, the client answers through the store, the agent gets `selected`.
    await client.unary("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m2", content: "need permission" }, { instance: deviceId });
    await view.until((v) => (v.control?.pending.length ?? 0) === 1, "pending permission");
    const request = view.control?.pending[0];
    assert.ok(request);
    assert.deepEqual(request.options.map((o) => o.kind), ["allow_once", "reject_once"]);
    assert.deepEqual(await client.unary("aa.v3.Sessions", "answer", { id: created.id, request_id: request.request_id, option_id: "allow" }, { instance: deviceId }), { ok: true });
    await view.until((v) => v.texts().includes("permission:allow") && v.idle(), "agent saw the answer");
    const late = await rejection(client.unary("aa.v3.Sessions", "answer", { id: created.id, request_id: request.request_id, option_id: "deny" }, { instance: deviceId }));
    assert.equal(reasonOf(late), "already_answered");
    assert.ok(view.control?.answered?.some((a) => a.request_id === request.request_id && a.option_id === "allow"));

    // MCP send_message with wait: the reply comes back in the call; other clients see the MCP author.
    const viaMcp = await control.unary<object, { message_id: string; reply_text?: string; delivered: string }>(
      "aa.v3.Sessions", "send", { session_id: created.id, text: "via mcp", wait: true }, { ...direct("mcp", { "aa-mcp-client": "Claude" }), timeoutMs: 30_000 });
    assert.equal(viaMcp.delivered, "started");
    assert.equal(viaMcp.reply_text, "echo: via mcp");
    await view.until((v) => {
      const m = v.messages.get(viaMcp.message_id);
      return m?.role === "user" && m.author === "mcp:Claude";
    }, "MCP author on the user message");

    // MCP answer_approval: decision "reject" picks the reject_once option.
    await control.unary("aa.v3.Sessions", "send", { session_id: created.id, text: "permission again" }, direct("mcp", { "aa-mcp-client": "Claude" }));
    await view.until((v) => (v.control?.pending.length ?? 0) === 1, "second pending permission");
    const second = view.control?.pending[0];
    assert.ok(second);
    await control.unary("aa.v3.Sessions", "answer", { session_id: created.id, approval_id: second.request_id, decision: "reject", reason: "no" }, direct("mcp", { "aa-mcp-client": "Claude" }));
    await view.until((v) => v.texts().includes("permission:deny") && v.idle(), "agent saw the MCP rejection");

    // The agent reads a file through fs/read_text_file (relative to the session cwd).
    await client.unary("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "m3", content: "read notes.txt" }, { instance: deviceId });
    await view.until((v) => v.texts().includes("file:hello from disk"), "fs/read_text_file result");

    // A busy session queues; stop cancels the running turn.
    await view.until((v) => v.idle(), "idle before the queue test");
    await client.unary("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "slow-1", content: "slow one" }, { instance: deviceId });
    const queued = await client.unary<object, { delivered: string }>("aa.v3.Sessions", "send", { id: created.id, client_msg_id: "q-1", content: "after slow" }, { instance: deviceId });
    assert.equal(queued.delivered, "queued");
    await view.until((v) => v.control?.queued.some((q) => q.client_msg_id === "q-1") ?? false, "queued message visible");
    await view.until((v) => v.texts().includes("echo: after slow") && v.idle(), "queued message ran after the slow turn", 15_000);

    // MCP read_session paging: next_cursor walks back.
    const page = await control.unary<object, { messages: Message[]; has_more: boolean; next_cursor?: string }>(
      "aa.v3.Sessions", "list_messages", { session_id: created.id, limit: 2 }, direct("mcp", { "aa-mcp-client": "Claude" }));
    assert.equal(page.has_more, true);
    assert.ok(page.next_cursor);
    const older = await control.unary<object, { messages: Message[] }>(
      "aa.v3.Sessions", "list_messages", { session_id: created.id, cursor: page.next_cursor, limit: 2 }, direct("mcp", { "aa-mcp-client": "Claude" }));
    assert.ok((older.messages.at(-1)?.seq ?? Infinity) < (page.messages[0]?.seq ?? -1));

    // The list as server-v3 sees it after all that.
    const after = await control.unary("aa.v3.Sessions", "list", {}, direct("client"));
    validate("SessionListPayload", after);

    // Terminals: duplex attach through the tunnel.
    if (!IS_WINDOWS) {
      const term = await client.unary<object, { id: string }>("aa.v3.Terminals", "create", { cwd: workDir, shell: "/bin/sh" }, { instance: deviceId });
      const attach = client.duplex<object, { type: string; data?: string; generation?: number }, { type: string; data?: string; exit_code?: number | null }>(
        "aa.v3.Terminals", "attach", { id: term.id, mode: "control" }, { instance: deviceId });
      // The first controller of a fresh terminal holds generation 1.
      await attach.send({ type: "input", data: Buffer.from("echo attach-$((40+2))\nexit\n").toString("base64"), generation: 1 });
      let output = "";
      let exited = false;
      for await (const event of attach) {
        if (event.type === "output" && event.data) output += Buffer.from(event.data, "base64").toString("utf8");
        if (event.type === "exit") {
          exited = true;
          break;
        }
      }
      assert.ok(output.includes("attach-42"), output);
      assert.ok(exited);
    }

    // DeviceAdmin/close_tunnel_sessions ends that tunnel's streams.
    const list = client.serverStream<object, SessionListEvent>("aa.v3.Sessions", "watch_list", {}, { instance: deviceId });
    const first = await list.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.type, "snapshot");
    assert.deepEqual(await control.unary("aa.v3.DeviceAdmin", "close_tunnel_sessions", { tunnel_id: tunnelId }, { instance: deviceId }), { ok: true });
    const ended = await Promise.race([list.next(), sleep(5000).then(() => "timeout" as const)]);
    assert.notEqual(ended, "timeout", "watch_list should end once its tunnel is closed");
    await view.until((v) => v.ended, "watch ended with its tunnel");

    // Persisted to sessions.json (debounced).
    await host.flush();
    const saved = JSON.parse(await readFile(path.join(tmp, "state", "sessions.json"), "utf8")) as unknown[];
    assert.equal(saved.length, 1);
  });

  it("terminals: one controller, viewers rejected, takeover drops stale input, resume_seq", { skip: IS_WINDOWS }, async () => {
    const { mesh: laptop } = await tunnelClient("user:u1/client:laptop");
    const { mesh: phone } = await tunnelClient("user:u1/client:phone");
    const created = await laptop.unary<object, TerminalInfoWire>("aa.v3.Terminals", "create", { cwd: workDir, shell: "/bin/sh", cols: 80, rows: 24 }, { instance: deviceId });
    validate("TerminalInfo", created);
    assert.equal(created.mode, "pty");
    assert.equal(created.controller, null);

    const open = (mesh: Mesh, request: Record<string, unknown>) => {
      validate("AttachRequest", request);
      return new TerminalStream(
        mesh.duplex<object, unknown, TerminalFrame>("aa.v3.Terminals", "attach", request, { instance: deviceId }),
        (frame) => validate("TerminalOutputFrame", frame),
      );
    };
    const send = async (stream: TerminalStream, frame: Record<string, unknown>) => {
      validate("TerminalInputFrame", frame);
      await stream.call.send(frame);
    };
    const input = (text: string, generation: number) => ({ type: "input", data: Buffer.from(text).toString("base64"), generation });

    // A (laptop) creates and controls; B (phone) watches.
    const a = open(laptop, { id: created.id, mode: "control", cols: 100, rows: 30, label: "Chrome · macOS" });
    assert.equal((await a.next()).type, "snapshot");
    const aCtl = await a.control();
    assert.equal(aCtl.you, true);
    assert.equal(aCtl.generation, 1);
    assert.deepEqual([aCtl.controller?.client_id, aCtl.controller?.label, aCtl.cols, aCtl.rows], ["user:u1/client:laptop", "Chrome · macOS", 100, 30]);
    const b = open(phone, { id: created.id, label: "iPhone" });
    assert.equal((await b.next()).type, "snapshot");
    const bCtl = await b.control();
    assert.equal(bCtl.you, false);
    assert.equal(bCtl.controller?.client_id, "user:u1/client:laptop");

    // B's input is dropped and answered with one `rejected`.
    await send(b, input("echo from-phone-$((1+1))\n", 1));
    assert.deepEqual(await b.rejected(), { type: "rejected", reason: "not_controller", generation: 1 });
    await send(a, input("stty size | sed 's/^/size=/'; echo from-laptop-$((2+2))\n", 1));
    await a.untilText(/from-laptop-4/);
    await b.untilText(/from-laptop-4/);
    assert.match(a.text, /size=30 100/);

    // B claims with its own size: A is told and becomes a viewer.
    await send(b, { type: "claim", cols: 90, rows: 25 });
    const bNow = await b.control((f) => f.generation === 2);
    assert.equal(bNow.you, true);
    assert.deepEqual([bNow.cols, bNow.rows], [90, 25]);
    const aNow = await a.control((f) => f.generation === 2);
    assert.equal(aNow.you, false);
    assert.equal(aNow.controller?.client_id, "user:u1/client:phone");
    assert.equal(aNow.controller?.label, "iPhone");

    // A's stale keystrokes are dropped; B's go through.
    await send(a, input("echo stale-$((3+3))\n", 1));
    assert.deepEqual(await a.rejected(), { type: "rejected", reason: "not_controller", generation: 2 });
    await send(b, input("stty size | sed 's/^/size=/'; echo from-phone-$((4+4))\n", 2));
    await b.untilText(/from-phone-8/);
    assert.match(b.text, /size=25 90/);
    assert.doesNotMatch(b.text, /stale-6|from-phone-2/);

    // The unary resize is controller-only.
    const refused = await rejection(laptop.unary("aa.v3.Terminals", "resize", { id: created.id, cols: 70, rows: 20 }, { instance: deviceId }));
    assert.equal(reasonOf(refused), "not_controller");
    const resized = await phone.unary<object, TerminalInfoWire>("aa.v3.Terminals", "resize", { id: created.id, cols: 70, rows: 20 }, { instance: deviceId });
    validate("TerminalInfo", resized);
    assert.equal(resized.cols, 70);
    assert.equal((await a.control((f) => f.cols === 70)).rows, 20);

    const listed = await laptop.unary<object, { terminals: TerminalInfoWire[] }>("aa.v3.Terminals", "list", {}, { instance: deviceId });
    for (const t of listed.terminals) validate("TerminalInfo", t);
    const info = listed.terminals.find((t) => t.id === created.id);
    assert.ok(info);
    assert.deepEqual([info.viewers, info.generation, info.controller?.client_id, info.controller?.connected], [2, 2, "user:u1/client:phone", true]);

    // A drops off and comes back with resume_seq (and mode=control, which does not take control from B):
    // only the missed output, no snapshot, and A is a viewer.
    const lastSeen = a.lastSeq;
    assert.ok(lastSeen > 0);
    await a.call.cancel();
    await eventually(() => host.terminals.get(created.id).viewers === 1 || undefined, "laptop stream gone");
    await send(b, input("echo while-away-$((5+5))\n", 2));
    await b.untilText(/while-away-10/);
    const again = open(laptop, { id: created.id, mode: "control", cols: 100, rows: 30, resume_seq: lastSeen, label: "Chrome · macOS" });
    const firstBack = await again.next();
    assert.equal(firstBack.type, "output", "a resumed stream starts with output, not a snapshot");
    assert.equal(firstBack.seq, lastSeen + 1);
    await again.untilText(/while-away-10/);
    const backCtl = await again.control();
    assert.deepEqual([backCtl.you, backCtl.generation, backCtl.controller?.client_id, backCtl.cols], [false, 2, "user:u1/client:phone", 70]);
    assert.ok(!again.seen.some((f) => f.type === "snapshot"));

    // The controller types `exit`: every stream ends with the exit frame.
    await send(b, input("exit\n", 2));
    for (const stream of [b, again]) {
      const exit = await stream.until((f) => f.type === "exit", "exit");
      assert.equal(exit.exit_code, 0);
    }
  });

  it("presence and push reach aa.v3.Control in the contract's shape", async () => {
    const serving = await new Mesh(routerUrl).mount(new FakeControl(), { accessLog: false }).startServing();
    controlHost = serving;
    const tokens = [{ router_id: "local", router_url: router.url, token: "", token_id: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() }];
    let mode: "normal" | "encrypted" = "normal";
    const presence = new ControlPresenceClient({
      deviceId,
      platform: "linux",
      connectorVersion: "3.0.0-test",
      getMode: () => mode,
      getSummary: () => host.presenceSummary(),
      e2ePublicKey: host.gate.e2ePublicKey,
      tokens,
      intervalMs: 60_000,
    });
    presence.start();
    try {
      const normal = await eventually(() => received.presence[0], "a normal presence report");
      validate("PresenceReport", normal);
      assert.ok("summary" in normal && !("e2e_public_key_hint" in normal));
      assert.deepEqual((normal as unknown as PresenceReport).summary?.runtimes, ["mock"]);

      mode = "encrypted";
      presence.reportNow();
      const encrypted = await eventually(() => received.presence[1], "an encrypted presence report");
      validate("PresenceReport", encrypted);
      assert.ok(!("summary" in encrypted), "encrypted presence must omit summary");
      assert.equal(encrypted.e2e_public_key_hint, host.gate.e2ePublicKey);

      await presence.notifyPush({ event_type: "approval", session_id: "s1", title: "secret title", body: "secret body" });
      const stripped = received.pushes.at(-1);
      validate("PushNotificationRequest", stripped);
      assert.deepEqual(stripped, { device_id: deviceId, event_type: "approval" });
      mode = "normal";
      await presence.notifyPush({ event_type: "activity", session_id: "s1", title: "t", body: "b" });
      assert.deepEqual(received.pushes.at(-1), { device_id: deviceId, event_type: "activity", session_id: "s1", title: "t", body: "b" });
    } finally {
      await presence.stop();
    }
  });

  it("safe switch normal → encrypted: connections drop, plain tunnels and direct calls refused, DeviceAdmin still works", async () => {
    const { mesh: before } = await tunnelClient();
    assert.ok(await before.unary("aa.v3.Sessions", "list", {}, { instance: deviceId }));

    await host.switchMode("encrypted");
    assert.equal(host.mode, "encrypted");
    const settings = JSON.parse(await readFile(path.join(tmp, "state", "settings.json"), "utf8")) as { mode: string };
    assert.equal(settings.mode, "encrypted");

    // The old plain-tunnel connection no longer reaches business services.
    const old = await rejection(before.unary("aa.v3.Sessions", "list", {}, { instance: deviceId, timeoutMs: 5000 }));
    assert.ok(old instanceof Error, "the pre-switch tunnel must not work any more");

    // A new plain tunnel is refused by the device.
    const plain = await rejection(control.tunnels.open({ instance: deviceId, scopes: SCOPES, principal: "user:u1" }));
    assert.ok(plain instanceof PermissionDeniedError, String(plain));
    assert.equal(reasonOf(plain), "tunnel_rejected");

    // The control plane cannot read business data directly any more…
    const directCall = await rejection(control.unary("aa.v3.Sessions", "list", {}, direct("client")));
    assert.ok(directCall instanceof PermissionDeniedError, String(directCall));
    assert.equal(reasonOf(directCall), "e2e_peer_required");
    const mcpCall = await rejection(control.unary("aa.v3.Sessions", "list", {}, direct("mcp", { "aa-mcp-client": "Claude" })));
    assert.equal(reasonOf(mcpCall), "e2e_peer_required");

    // …but DeviceAdmin stays reachable.
    validate("DeviceAdminPingResponse", await control.unary("aa.v3.DeviceAdmin", "ping", {}, { instance: deviceId }));
  });

  it("encrypted mode: pairing (IKpsk2), stranger refused, reconnect (IK), revocation", async () => {
    const { payload } = await host.createPairing(60_000, { label: "Alice phone", platform: "ios" });
    assert.equal(payload.instance_id, deviceId);
    assert.equal(payload.device_pub, host.gate.e2ePublicKey);
    const alice = await generateE2EKey();
    const mallory = await generateE2EKey();
    const e2eTunnel = async (principal: string) =>
      (await control.tunnels.open({ instance: deviceId, scopes: SCOPES, principal, e2eKey: payload.device_pub })).credential;
    const connect = async (keys: E2EKeyPair, pairing?: { id: string; psk: string }) =>
      new Mesh(routerUrl, {
        tunnel: await e2eTunnel("user:u1/client:x"),
        e2eKey: payload.device_pub,
        e2eIdentity: { privateKey: keys.privateKey, instanceId: deviceId, ...(pairing ? { pairing } : {}) },
      });

    // First connection pairs.
    const paired = await connect(alice, { id: payload.pairing_id, psk: payload.psk });
    cleanup.push(paired);
    const listed = await paired.unary<object, { sessions: unknown[] }>("aa.v3.Sessions", "list", {}, { instance: deviceId });
    assert.equal(listed.sessions.length, 1);
    const status = await paired.unary<object, { mode: string; device_id: string }>("aa.v3.Device", "status", {}, { instance: deviceId });
    assert.equal(status.mode, "encrypted");
    assert.equal(status.device_id, deviceId);
    const entry = host.listPairedClients().find((c) => c.client_pub === alice.publicKey);
    assert.equal(entry?.label, "Alice phone");
    assert.equal(entry?.platform, "ios");
    const onDisk = JSON.parse(await readFile(path.join(tmp, "state", "paired-clients.json"), "utf8")) as { client_pub: string }[];
    assert.ok(onDisk.some((c) => c.client_pub === alice.publicKey));
    // Even a paired client cannot claim to be MCP.
    const fakeMcp = await rejection(paired.unary("aa.v3.Sessions", "list", {}, { instance: deviceId, metadata: { "aa-via": "mcp" } }));
    assert.equal(reasonOf(fakeMcp), "e2e_peer_required");

    // A stranger fails the handshake, with or without the spent pairing.
    for (const pairing of [undefined, { id: payload.pairing_id, psk: payload.psk }]) {
      const stranger = await connect(mallory, pairing);
      try {
        const refused = await rejection(stranger.unary("aa.v3.Sessions", "list", {}, { instance: deviceId }));
        assert.ok(refused instanceof UnauthenticatedError, String(refused));
        assert.equal(reasonOf(refused), "e2e_handshake_failed");
      } finally {
        await stranger.close();
      }
    }

    // The paired client comes back with plain IK.
    const again = await connect(alice);
    cleanup.push(again);
    assert.equal((await again.unary<object, { sessions: unknown[] }>("aa.v3.Sessions", "list", {}, { instance: deviceId })).sessions.length, 1);

    // Revoked: the live session is refused per call, the next handshake fails.
    assert.equal(host.revokePairedClient(alice.publicKey), true);
    const live = await rejection(again.unary("aa.v3.Sessions", "list", {}, { instance: deviceId }));
    assert.ok(live instanceof Error);
    const next = await connect(alice);
    try {
      const refused = await rejection(next.unary("aa.v3.Sessions", "list", {}, { instance: deviceId }));
      assert.ok(refused instanceof UnauthenticatedError, String(refused));
      assert.equal(reasonOf(refused), "e2e_handshake_failed");
    } finally {
      await next.close();
    }
  });

  it("encrypted mode: a typed pairing code pairs; a wrong code fails without spending it", async () => {
    // The client knows the device key from the control plane (e2e_public_key_hint), not from a QR code.
    const devicePub = host.gate.e2ePublicKey;
    const created = await host.createPairingCode(60_000, { label: "Bob browser", platform: "web" });
    const connect = async (keys: E2EKeyPair, code: string) =>
      new Mesh(routerUrl, {
        tunnel: (await control.tunnels.open({ instance: deviceId, scopes: SCOPES, principal: "user:u1/client:code", e2eKey: devicePub })).credential,
        e2eKey: devicePub,
        e2eIdentity: { privateKey: keys.privateKey, instanceId: deviceId, pairing: { id: PAIRING_CODE_ID, psk: await derivePairingCodePsk(code, deviceId) } },
      });

    // A typo: the handshake fails and the code is still good.
    const typo = created.code.startsWith("0") ? `1${created.code.slice(1)}` : `0${created.code.slice(1)}`;
    const wrong = await connect(await generateE2EKey(), typo);
    try {
      const refused = await rejection(wrong.unary("aa.v3.Sessions", "list", {}, { instance: deviceId }));
      assert.ok(refused instanceof Error, String(refused));
    } finally {
      await wrong.close();
    }

    const bob = await generateE2EKey();
    const paired = await connect(bob, created.code.toLowerCase());
    cleanup.push(paired);
    const status = await paired.unary<object, { mode: string }>("aa.v3.Device", "status", {}, { instance: deviceId });
    assert.equal(status.mode, "encrypted");
    const entry = host.listPairedClients().find((c) => c.client_pub === bob.publicKey);
    assert.equal(entry?.label, "Bob browser");
    assert.equal(entry?.platform, "web");

    // Spent: the same code does not pair anyone else.
    const late = await connect(await generateE2EKey(), created.code);
    try {
      const refused = await rejection(late.unary("aa.v3.Sessions", "list", {}, { instance: deviceId }));
      assert.ok(refused instanceof UnauthenticatedError, String(refused));
    } finally {
      await late.close();
    }
  });
});
