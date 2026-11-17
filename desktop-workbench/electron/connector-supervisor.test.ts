import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopSettingsStore } from "./desktop-settings";
import { ConnectorSupervisor, type ConfirmationEvent, type ConnectorChannel, type Rendezvous } from "./connector-supervisor";
import type { ConfirmClientApproval } from "./backend/protocol";
import type { ConnectorHostMessage, ConnectorProcess } from "./connector-launcher";
import { ConnectorLogStore } from "./log-store";
import { ConnectorRpcError } from "./connector-rpc-error";
import type { OwnershipState } from "./local-runtime";
import type { ConnectorLogEntry } from "./connector-types";

const CREDENTIALS = { serverUrl: "https://example.test", connectorId: "desktop-id", connectorToken: "private-token" };

type State = { running: boolean; authFailed: boolean; status?: string };

/** What the supervisor needs from one Connector's control channel. */
function fakeChannel(overrides: Partial<ConnectorChannel["control"]> = {}): ConnectorChannel & { saved: unknown[] } {
  const state = (running: boolean): State => ({ running, authFailed: false, status: running ? "running" : "stopped" });
  const stayOpen = async function* (_since: number | null, options?: { signal?: AbortSignal }) {
    await new Promise<void>(resolve => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  const saved: unknown[] = [];
  const empty = { items: [], firstSeq: null, lastSeq: null, total: 0, hasMoreBefore: false, hasMoreAfter: false };
  return {
    saved,
    control: {
      getState: async () => state(false),
      acquireOwnership: async () => state(false),
      saveConfig: async (config: unknown) => { saved.push(config); return config; },
      start: async () => state(true),
      stop: async () => state(false),
      restart: async () => state(true),
      events: stayOpen,
      ...overrides,
    },
    logs: { tail: (_since, _source, options) => stayOpen(null, options), read: async () => empty, clear: async () => empty },
    close: async () => {},
  };
}

/** An in-memory utility process: tests post its parent-port messages and decide when it exits. */
class FakeProcess implements ConnectorProcess {
  private static nextId = 1;
  readonly id = FakeProcess.nextId++;
  shutdowns = 0;
  kills = 0;
  exited = false;
  private readonly messages: Array<(message: ConnectorHostMessage) => void> = [];
  private readonly outputs: Array<(line: string) => void> = [];
  private readonly exits: Array<(exit: { code: number | null; error?: string }) => void> = [];

  constructor(readonly env: Record<string, string>, private readonly onShutdown: "exit" | "hang" = "exit") {}

  onMessage(listener: (message: ConnectorHostMessage) => void): void { this.messages.push(listener); }
  onOutput(listener: (line: string) => void): void { this.outputs.push(listener); }
  onExit(listener: (exit: { code: number | null; error?: string }) => void): void { this.exits.push(listener); }

  shutdown(): void {
    this.shutdowns++;
    if (this.onShutdown === "exit") setImmediate(() => { this.post({ type: "stopped", reason: "shutdown" }); this.exit(0); });
  }

  kill(): void {
    this.kills++;
    setImmediate(() => this.exit(null));
  }

  post(message: ConnectorHostMessage): void { for (const listener of this.messages) listener(message); }
  print(line: string): void { for (const listener of this.outputs) listener(line); }

  ready(): void {
    this.post({
      type: "ready", kind: "connector.ready", version: 1, instanceId: `instance-${this.id}`, pid: 4000 + this.id,
      endpoint: { unixPath: "/nonexistent/router.sock" }, key: "mk_host_fake",
    });
  }

  exit(code: number | null, error?: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exits) listener({ code, ...(error ? { error } : {}) });
  }
}

type Fixture = {
  root: string;
  supervisor: ConnectorSupervisor;
  settings: DesktopSettingsStore;
  processes: FakeProcess[];
  rendezvous: Rendezvous[];
  ownership: OwnershipState[];
  logs: ConnectorLogEntry[];
  configPath: string;
};

function fixture(t: TestContext, options: {
  channel?: () => ConnectorChannel;
  /** What a launched process does on its own; the default posts `ready` at once. */
  boot?: (child: FakeProcess) => void;
  credentials?: boolean;
  routerBinary?: string;
  frpcBinary?: string;
  onShutdown?: "exit" | "hang";
  confirmClientApproval?: ConfirmClientApproval;
  /** Pids the lease watch sees as running. */
  alive?: Set<number>;
  externalWatch?: { intervalMs?: number; probeBackoffMs?: number; maxProbeBackoffMs?: number; slowProbeMs?: number };
  onReclaimed?: (reclaimed: { resume: boolean }) => void;
} = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-supervisor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "connector.json");
  if (options.credentials !== false) fs.writeFileSync(configPath, JSON.stringify(CREDENTIALS));
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"));
  const processes: FakeProcess[] = [];
  const rendezvous: Rendezvous[] = [];
  const ownership: OwnershipState[] = [];
  const logs: ConnectorLogEntry[] = [];
  const boot = options.boot ?? (child => setImmediate(() => child.ready()));
  const supervisor = new ConnectorSupervisor({
    configPath,
    dataPath: root,
    resourcesPath: root,
    packaged: false,
    homePath: root,
    routerBinary: options.routerBinary ?? "",
    frpcBinary: options.frpcBinary ?? "",
    shellEnvironment: { PATH: "/shell/bin" },
    settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")),
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    launch: env => {
      const child = new FakeProcess(env, options.onShutdown);
      processes.push(child);
      boot(child);
      return child;
    },
    onOwnership: state => ownership.push(state),
    onState: () => {},
    onLog: entry => logs.push(entry),
    connectControl: async value => { rendezvous.push(value); return (options.channel ?? fakeChannel)(); },
    ...(options.confirmClientApproval ? { confirmClientApproval: options.confirmClientApproval } : {}),
    ...(options.alive ? { processAlive: (pid: number) => options.alive!.has(pid) } : {}),
    ...(options.externalWatch ? { externalWatch: options.externalWatch } : {}),
    ...(options.onReclaimed ? { onReclaimed: options.onReclaimed } : {}),
  });
  t.after(() => supervisor.shutdown());
  return { root, supervisor, settings, processes, rendezvous, ownership, logs, configPath };
}

const isConflict = (error: unknown) => error instanceof ConnectorRpcError && error.ownershipConflict && error.code === -32009;

test("the embedded Connector runs with Desktop's config, its Router and the desktop owner kind", async (t) => {
  const f = fixture(t, { routerBinary: "/bundle/meshcall-router", frpcBinary: "/bundle/frpc" });
  f.settings.save({ connectorProxy: "http://127.0.0.1:7890" });
  await f.supervisor.acquireOwnership();
  assert.equal(f.processes.length, 1);
  const env = f.processes[0]!.env;
  assert.equal(env.AGENT_CONNECTOR_CONFIG, f.configPath);
  assert.equal(env.AA_CONNECTOR_OWNER_KIND, "desktop-workbench");
  assert.equal(env.MESHCALL_ROUTER_BINARY, "/bundle/meshcall-router");
  // Port preview: the bundled frpc, leaving through the same explicit proxy as the device link.
  assert.equal(env.AA_FRPC_BINARY, "/bundle/frpc");
  assert.equal(env.AA_PREVIEW_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  // The shared v3 data directory is the Connector's own default, never Desktop's.
  assert.equal(env.AGENT_CONNECTOR_DATA_DIR, process.env.AGENT_CONNECTOR_DATA_DIR);
  assert.ok(env.PATH?.split(path.delimiter).includes("/shell/bin"));
  assert.equal(f.rendezvous[0]?.key, "mk_host_fake");
  assert.deepEqual(f.ownership.map(state => state.status), ["checking", "owned"]);
  // A second request reuses the running process.
  await f.supervisor.getState();
  assert.equal(f.processes.length, 1);
});

/** A `Control/confirmations` stream the test feeds, and the answers the supervisor sent. */
function confirmationFeed() {
  const queue: ConfirmationEvent[] = [];
  let wake: (() => void) | null = null;
  const answers: Array<{ confirmationId: string; approved: boolean }> = [];
  return {
    answers,
    push(event: ConfirmationEvent) { queue.push(event); wake?.(); },
    channel: {
      follow: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const next = queue.shift();
          if (next) { yield next; continue; }
          await new Promise<void>(resolve => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
        }
      },
      answer: async (confirmationId: string, approved: boolean) => { answers.push({ confirmationId, approved }); return { accepted: true }; },
    },
  };
}

const prompt = (confirmationId: string): ConfirmationEvent => ({
  kind: "requested",
  confirmation: { confirmationId, kind: "client_approval", approverLabel: "Phone", label: "Browser", fingerprint: "0123 4567 89ab cdef 0123 4567 89ab cdef", expiresAt: "2026-11-17T12:02:00.000Z" },
});

test("client approvals the Connector asks about are confirmed in a dialog; only a yes approves, a settled request closes it", async (t) => {
  const feed = confirmationFeed();
  const dialogs: Array<{ label: string; signal: AbortSignal; answer: (approved: boolean) => void }> = [];
  const f = fixture(t, {
    channel: () => ({ ...fakeChannel(), confirmations: feed.channel }),
    confirmClientApproval: (request, signal) => new Promise<boolean>(resolve => {
      dialogs.push({ label: request.label, signal, answer: resolve });
      signal.addEventListener("abort", () => resolve(true), { once: true });
    }),
  });
  await f.supervisor.start();
  feed.push(prompt("conf_1"));
  feed.push(prompt("conf_1"));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dialogs.length, 1, "one dialog per request");
  dialogs[0]!.answer(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  feed.push(prompt("conf_2"));
  await new Promise(resolve => setTimeout(resolve, 20));
  dialogs[1]!.answer(false);
  await new Promise(resolve => setTimeout(resolve, 20));
  // Timed out on the Connector: the dialog closes and nothing is answered for it.
  feed.push(prompt("conf_3"));
  await new Promise(resolve => setTimeout(resolve, 20));
  feed.push({ kind: "settled", confirmationId: "conf_3", approved: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dialogs[2]!.signal.aborted, true);
  assert.deepEqual(feed.answers, [{ confirmationId: "conf_1", approved: true }, { confirmationId: "conf_2", approved: false }]);
});

test("a Connector that fails to start reports its code and output", async (t) => {
  const f = fixture(t, {
    boot: child => setImmediate(() => {
      child.print("\u001b[31mcannot open store.sqlite\u001b[0m");
      child.post({ type: "failed", code: "store_locked", message: "the store is locked" });
      child.exit(1);
    }),
  });
  await assert.rejects(f.supervisor.acquireOwnership(), /store_locked.*the store is locked[\s\S]*cannot open store\.sqlite/);
  assert.equal(f.ownership.at(-1)?.status, "error");
  assert.equal(f.supervisor.publicState().running, false);
});

test("a v2 or unknown Connector is a conflict the user resolves", async (t) => {
  let conflict = true;
  const f = fixture(t, {
    channel: () => fakeChannel({
      acquireOwnership: async () => {
        if (conflict) throw { code: "connector_already_running", message: "", details: { reason: "connector_already_running", owner: { kind: "cli", pid: 1234 }, decision: "conflict" } };
        return { running: false, authFailed: false };
      },
    }),
  });
  await assert.rejects(f.supervisor.acquireOwnership(), isConflict);
  const state = f.ownership.at(-1);
  assert.equal(state?.status, "conflict");
  assert.match(state?.message ?? "", /其他 Connector/);
  assert.match(state?.message ?? "", /cli, PID 1234/);
  assert.equal(state?.status === "conflict" ? state.recovery : undefined, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, "utf8")), CREDENTIALS);
  conflict = false;
  await f.supervisor.acquireOwnership();
  assert.equal(f.ownership.at(-1)?.status, "owned");
  assert.equal(f.processes.length, 1, "a refused claim keeps the process for the retry");
});

/** The shared lease record as the Connector writes it; `null` removes its owner. */
function writeRuntimeRecord(root: string, owner: Record<string, unknown> | null): void {
  const file = path.join(root, ".agents-anywhere", "connector-runtime.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, connectorIds: [], ...(owner ? { runtime: owner } : {}) }));
}

const newerOwner = (pid: number, connectorVersion: string, kind = "dsh-plugin") => ({
  instanceId: `owner-${pid}`, kind, pid, startedAt: "2026-11-17T08:00:00.000Z", connectorVersion,
  connectorId: "cli-device", serverUrl: "https://example.test",
});

const useExisting = (pid: number, kind = "dsh-plugin") => ({
  code: "connector_already_running", message: "newer",
  details: { reason: "connector_already_running", owner: { kind, pid }, decision: "use_existing" },
});

const until = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const FAST_WATCH = { intervalMs: 5, probeBackoffMs: 10, maxProbeBackoffMs: 40, slowProbeMs: 60_000 };

test("a newer Connector serving the machine makes Desktop step aside without blocking, and Desktop takes the machine back once it exits", async (t) => {
  let newer = true;
  const alive = new Set([77]);
  const reclaimed: Array<{ resume: boolean }> = [];
  const f = fixture(t, {
    alive,
    externalWatch: FAST_WATCH,
    onReclaimed: value => reclaimed.push(value),
    channel: () => fakeChannel({
      acquireOwnership: async () => {
        if (newer) throw useExisting(77);
        return { running: false, authFailed: false };
      },
    }),
  });
  writeRuntimeRecord(f.root, newerOwner(77, "3.2.0"));
  await assert.rejects(f.supervisor.acquireOwnership(), isConflict);
  const state = f.ownership.at(-1);
  assert.equal(state?.status, "external");
  assert.equal(state?.recovery, undefined);
  assert.deepEqual(state?.external, {
    kind: "dsh-plugin", pid: 77, version: "3.2.0", connectorId: "cli-device", serverUrl: "https://example.test", handedOver: false,
  });
  assert.deepEqual(f.ownership.map(value => value.status), ["checking", "external"], "the workspace is never blocked again");
  // Desktop's own process stops and nothing restarts it while the newer Connector runs.
  await until(() => f.processes[0]!.exited);
  assert.equal(f.processes[0]!.shutdowns, 1);
  await assert.rejects(f.supervisor.start(), isConflict);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.processes.length, 1, "a live owner is watched through its record, not by launching Desktop's Connector");
  assert.equal(f.logs.some(entry => entry.message.includes("will restart")), false);
  // The newer Connector exits and releases its lease: Desktop claims the machine back on its own.
  newer = false;
  alive.delete(77);
  writeRuntimeRecord(f.root, null);
  await until(() => f.ownership.at(-1)?.status === "owned");
  assert.equal(f.processes.length, 2);
  assert.deepEqual(reclaimed, [{ resume: false }]);
  assert.equal(f.ownership.some(value => value.status === "checking" && f.ownership.indexOf(value) > 0), false);
  // Owned again: the watch is over.
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.processes.length, 2);
});

test("a Connector that hands over to a newer one is not restarted, and its runtime resumes once the newer one exits", async (t) => {
  let newerRunning = true;
  const alive = new Set([88]);
  const reclaimed: Array<{ resume: boolean }> = [];
  const f = fixture(t, {
    alive,
    externalWatch: FAST_WATCH,
    onReclaimed: value => reclaimed.push(value),
    channel: () => fakeChannel({
      acquireOwnership: async () => {
        if (newerRunning) throw useExisting(88, "cli");
        return { running: false, authFailed: false };
      },
    }),
  });
  await f.supervisor.start();
  assert.equal(f.supervisor.publicState().running, true);
  writeRuntimeRecord(f.root, newerOwner(88, "3.3.0", "cli"));
  const child = f.processes[0]!;
  child.post({ type: "stopped", reason: "handed_over" });
  child.exit(0);
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = f.ownership.at(-1);
  assert.equal(state?.status, "external");
  assert.equal(state?.external?.handedOver, true);
  assert.equal(state?.external?.version, "3.3.0");
  assert.equal(state?.external?.kind, "cli");
  assert.equal(f.supervisor.publicState().running, false);
  assert.equal(f.supervisor.publicState().lastError, null);
  assert.equal(f.processes.length, 1);
  newerRunning = false;
  alive.delete(88);
  writeRuntimeRecord(f.root, null);
  await until(() => reclaimed.length === 1);
  assert.equal(f.ownership.at(-1)?.status, "owned");
  assert.deepEqual(reclaimed, [{ resume: true }], "the runtime that was running comes back");
});

test("taking the machine back backs off while claims keep finding a newer Connector", async (t) => {
  const launches: number[] = [];
  const f = fixture(t, {
    alive: new Set(),
    externalWatch: { intervalMs: 5, probeBackoffMs: 20, maxProbeBackoffMs: 80, slowProbeMs: 60_000 },
    boot: child => { launches.push(Date.now()); setImmediate(() => child.ready()); },
    // The record says nobody owns the machine, yet every claim is answered by a newer Connector.
    channel: () => fakeChannel({ acquireOwnership: async () => { throw useExisting(99); } }),
  });
  writeRuntimeRecord(f.root, null);
  await assert.rejects(f.supervisor.acquireOwnership(), isConflict);
  await until(() => launches.length >= 5, 3_000);
  const gaps = launches.slice(1).map((at, index) => at - launches[index]!);
  // Gaps: the first claim after 20ms, then 40ms, then the 80ms ceiling.
  for (const [index, minimum] of [20, 40, 80, 80].entries()) assert.ok(gaps[index]! >= minimum - 2, `gap ${index} was ${gaps[index]}ms`);
  assert.equal(f.ownership.at(-1)?.status, "external");
  assert.equal(f.logs.filter(entry => entry.message.includes("更新版本")).length, 2, "stepping aside is logged on the first claim only, not on every retry");
});

test("a v2 Connector found while taking the machine back is a conflict that blocks", async (t) => {
  let decision = "use_existing";
  const alive = new Set([77]);
  const f = fixture(t, {
    alive,
    externalWatch: FAST_WATCH,
    channel: () => fakeChannel({
      acquireOwnership: async () => {
        throw { code: "connector_already_running", message: "", details: { reason: "connector_already_running", owner: { kind: "cli", pid: 55 }, decision } };
      },
    }),
  });
  writeRuntimeRecord(f.root, newerOwner(77, "3.2.0"));
  await assert.rejects(f.supervisor.acquireOwnership(), isConflict);
  assert.equal(f.ownership.at(-1)?.status, "external");
  decision = "conflict";
  alive.delete(77);
  writeRuntimeRecord(f.root, null);
  await until(() => f.ownership.at(-1)?.status === "conflict");
  const launched = f.processes.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.processes.length, launched, "a conflict stops the watch");
});

test("an unexpected exit is recorded and restarts a running Connector", async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  f.processes[0]!.print("Error: boom");
  f.processes[0]!.exit(3);
  const state = f.supervisor.publicState();
  assert.equal(state.running, false);
  assert.match(state.lastError ?? "", /exited with code 3[\s\S]*Error: boom/);
  assert.ok(f.logs.some(entry => entry.message.includes("will restart in 1000ms")));
  const deadline = Date.now() + 3_000;
  while (!f.supervisor.publicState().running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.processes.length, 2);
  assert.equal(f.supervisor.publicState().running, true);
});

test("a stopped Connector exits quietly", async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  await f.supervisor.shutdown();
  assert.equal(f.processes[0]!.shutdowns, 1);
  // Once it posts `stopped`, only its parent port keeps it alive: it is ended at once, not after the grace period.
  assert.equal(f.processes[0]!.kills, 1);
  assert.equal(f.logs.some(entry => entry.message.includes("did not stop in time")), false);
  assert.equal(f.supervisor.publicState().lastError, null);
});

test("credentials reach the Connector with the proxy setting, and a proxy change restarts it", async (t) => {
  const channels: Array<ReturnType<typeof fakeChannel>> = [];
  let restarts = 0;
  const f = fixture(t, {
    channel: () => {
      const channel = fakeChannel({ restart: async () => { restarts++; return { running: true, authFailed: false }; } });
      channels.push(channel);
      return channel;
    },
    credentials: false,
  });
  await f.supervisor.saveCredentials(CREDENTIALS as never);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, "utf8")).connectorToken, "private-token");
  assert.equal((channels[0]!.saved[0] as { proxy?: string }).proxy, "system");
  await f.supervisor.start();
  const previous = f.settings.get();
  f.settings.save({ connectorProxy: "direct" });
  await f.supervisor.applySettings(previous);
  assert.equal((channels[0]!.saved.at(-1) as { proxy?: string }).proxy, "direct");
  assert.equal(restarts, 1);
  // Any other setting leaves the Connector alone.
  const unchanged = f.settings.get();
  f.settings.save({ notificationsEnabled: false });
  await f.supervisor.applySettings(unchanged);
  assert.equal(restarts, 1);
});

test("a Connector that ignores shutdown is killed", async (t) => {
  const f = fixture(t, { onShutdown: "hang" });
  await f.supervisor.acquireOwnership();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopping = f.supervisor.shutdown();
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  t.mock.timers.reset();
  await stopping;
  assert.equal(f.processes[0]!.kills, 1);
});

test("health checks rebuild a live but unresponsive Connector and tolerate transient failures", { timeout: 15_000 }, async (t) => {
  let failing = false;
  let probes = 0;
  const f = fixture(t, {
    channel: () => {
      const first = f === undefined || f.processes.length <= 1;
      return fakeChannel(first ? {
        getState: async (options?: { timeoutMs?: number }) => {
          if (options?.timeoutMs === 10_000) {
            probes++;
            if (failing) throw new Error("No instances registered for aa.local.v2.Control");
          }
          return { running: true, authFailed: false };
        },
      } : {});
    },
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  await f.supervisor.start();
  const probe = async () => {
    t.mock.timers.tick(30_000);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  failing = true;
  await probe();
  assert.equal(f.processes.length, 1, "one failed check must not kill the process");
  failing = false;
  await probe();
  failing = true;
  await probe();
  assert.equal(f.processes.length, 1, "a successful check resets the failure count");
  await probe();
  const deadline = Date.now() + 8_000;
  while ((f.processes.length < 2 || !f.supervisor.publicState().running) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(probes, 4);
  assert.equal(f.processes.length, 2, "rebuild the live process using the normal restart path");
  assert.equal(f.supervisor.publicState().running, true);
});
