// TerminalManager: real PTY, headless screen snapshots, seq resume, and the controller / viewer model
// (docs/v3/terminal-proposal.md).
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import headlessModule from "@xterm/headless";

import type { PairedClientEntry } from "../src/core/config.js";
import { terminalClientIdentity } from "../src/rpc/terminals-service.js";
import {
  TerminalManager,
  type TerminalAttachment,
  type TerminalEvent,
  type TerminalManagerOptions,
} from "../src/runtime/terminal-manager.js";

const { Terminal: HeadlessTerminal } = headlessModule;
const IS_WINDOWS = process.platform === "win32";
const SH = "/bin/sh";

let root: string;
const managers: TerminalManager[] = [];

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aa-v3-term-"));
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function manager(opts: TerminalManagerOptions = {}): TerminalManager {
  const created = new TerminalManager({ killGraceMs: 500, ...opts });
  managers.push(created);
  return created;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (data: string) => Buffer.from(data, "base64").toString("utf8");

/** Pulls frames off an attachment, remembering everything it has seen. */
class Reader {
  readonly seen: TerminalEvent[] = [];
  text = "";

  constructor(readonly att: TerminalAttachment) {}

  async next(timeoutMs = 10_000): Promise<TerminalEvent | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([this.att.next(), timeout]);
      if (result === "timeout") throw new Error(`no frame within ${timeoutMs} ms; seen ${JSON.stringify(this.seen.map((e) => e.type))}`);
      if (result.done) return undefined;
      this.seen.push(result.value);
      if (result.value.type === "output") this.text += decode(result.value.data);
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Frames until one matches; returns it. */
  async until<T extends TerminalEvent>(match: (event: TerminalEvent) => event is T, what: string, timeoutMs?: number): Promise<T>;
  async until(match: (event: TerminalEvent) => boolean, what: string, timeoutMs?: number): Promise<TerminalEvent>;
  async until(match: (event: TerminalEvent) => boolean, what: string, timeoutMs = 10_000): Promise<TerminalEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = await this.next(Math.max(1, deadline - Date.now()));
      if (!event) throw new Error(`stream ended before ${what}`);
      if (match(event)) return event;
    }
  }

  /** Consume frames until the consumed output matches (no-op when it already does). */
  async untilText(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    if (!pattern.test(this.text)) await this.until(() => pattern.test(this.text), `output ${pattern}`, timeoutMs);
  }

  control(predicate: (event: Extract<TerminalEvent, { type: "control" }>) => boolean = () => true) {
    return this.until((e): e is Extract<TerminalEvent, { type: "control" }> => e.type === "control" && predicate(e), "control frame");
  }

  rejected() {
    return this.until((e): e is Extract<TerminalEvent, { type: "rejected" }> => e.type === "rejected", "rejected frame");
  }
}

/** Attach until the snapshot satisfies `ok` (the emulator parses output asynchronously). */
async function snapshotWhen(
  terminals: TerminalManager,
  id: string,
  ok: (text: string) => boolean,
): Promise<{ frame: Extract<TerminalEvent, { type: "snapshot" }>; reader: Reader }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const reader = new Reader(terminals.attach(id));
    const first = await reader.next();
    assert.equal(first?.type, "snapshot");
    if (first?.type === "snapshot" && ok(decode(first.data))) return { frame: first, reader };
    reader.att.close();
    await sleep(25);
  }
  throw new Error("snapshot never matched");
}

/** Render a snapshot into a fresh headless xterm.js, as a client would. */
async function render(frame: Extract<TerminalEvent, { type: "snapshot" }>) {
  const term = new HeadlessTerminal({ cols: frame.cols, rows: frame.rows, allowProposedApi: true, scrollback: 1000 });
  await new Promise<void>((resolve) => term.write(decode(frame.data), resolve));
  const buffer = term.buffer.active;
  const line = (row: number) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "";
  return { term, buffer, line, modes: term.modes };
}

describe("TerminalManager: PTY", { skip: IS_WINDOWS }, () => {
  test("pty is the default mode: TERM=xterm-256color, a tty, and resize reaches stty", async () => {
    const terminals = manager();
    assert.equal(await terminals.ptyAvailable(), true, "node-pty should load in the test environment");
    const info = await terminals.create({ shell: SH, cwd: root, cols: 80, rows: 24 });
    assert.equal(info.mode, "pty");
    assert.equal(info.owner, "user");
    assert.equal(info.controller, null);
    assert.equal(info.generation, 0);
    assert.equal(info.viewers, 0);

    const reader = new Reader(terminals.attach(info.id, { clientId: "desk", label: "Desk", mode: "control", cols: 100, rows: 30 }));
    assert.equal((await reader.next())?.type, "snapshot");
    const control = await reader.control();
    assert.equal(control.you, true);
    assert.equal(control.generation, 1);
    assert.equal(control.cols, 100);
    assert.equal(control.rows, 30);
    assert.deepEqual(terminals.get(info.id).controller?.client_id, "desk");
    assert.equal(terminals.get(info.id).viewers, 1);

    // Arithmetic keeps the echoed command line from matching.
    await reader.att.input("test -t 0 && echo tty-$((40+2)); echo term=$TERM; stty size | sed 's/^/size=/'\n", control.generation);
    await reader.untilText(/size=30 100/);
    assert.match(reader.text, /\btty-42/);
    assert.match(reader.text, /term=xterm-256color/);

    assert.equal(reader.att.resize(120, 40, control.generation), true);
    const resized = await reader.control((e) => e.cols === 120);
    assert.equal(resized.rows, 40);
    assert.equal(resized.generation, 1, "a resize does not change the generation");
    await reader.att.input("stty size | sed 's/^/size=/'\n", control.generation);
    await reader.untilText(/size=40 120/);
    assert.equal(terminals.get(info.id).cols, 120);

    await terminals.close(info.id);
    const exit = await reader.until((e) => e.type === "exit", "exit");
    assert.equal(exit.type, "exit");
  });

  test("the snapshot carries the alternate screen, cursor position and terminal modes", async () => {
    const terminals = manager();
    // Normal-screen history, then a full-screen program: alternate screen, mouse reporting, bracketed paste,
    // application cursor keys, a cursor move and some text.
    const script =
      "printf 'history-line\\n'; printf '\\033[?1049h\\033[?1000h\\033[?2004h\\033[?1h\\033[H\\033[2J\\033[5;7Hfull-screen'; sleep 30";
    const info = await terminals.create({ shell: SH, args: ["-c", script], cwd: root, cols: 60, rows: 20 });
    assert.equal(info.mode, "pty");
    const { frame, reader } = await snapshotWhen(terminals, info.id, (text) => text.includes("full-screen"));
    assert.equal(frame.cols, 60);
    assert.equal(frame.rows, 20);
    assert.ok(frame.seq >= 1);
    const control = await reader.next();
    assert.equal(control?.type, "control");

    const { term, buffer, line, modes } = await render(frame);
    assert.equal(buffer.type, "alternate");
    assert.equal(line(4).slice(6, 17), "full-screen");
    assert.equal(buffer.cursorY, 4);
    assert.equal(buffer.cursorX, 17);
    assert.equal(modes.mouseTrackingMode, "vt200");
    assert.equal(modes.bracketedPasteMode, true);
    assert.equal(modes.applicationCursorKeysMode, true);
    // The normal screen (with its history) is underneath.
    const normal = term.buffer.normal;
    const normalText = Array.from({ length: normal.length }, (_, i) => normal.getLine(i)?.translateToString(true) ?? "").join("\n");
    assert.match(normalText, /history-line/);
    term.dispose();
    await terminals.close(info.id);
  });
});

describe("TerminalManager: seq and resume", { skip: IS_WINDOWS }, () => {
  test("chunks are numbered, resume_seq replays only what is missing, otherwise a snapshot", async () => {
    const terminals = manager({ fallbackMode: "pipe" });
    const info = await terminals.create({ shell: SH, cwd: root, mode: "pipe" });
    const a = new Reader(terminals.attach(info.id, { clientId: "a", mode: "control" }));
    const first = await a.next();
    assert.deepEqual(first && { type: first.type, seq: (first as { seq: number }).seq }, { type: "snapshot", seq: 0 });
    const ctl = await a.control();
    for (const n of [1, 2, 3]) {
      await a.att.input(`echo line-$((${n}*11))\n`, ctl.generation);
      await a.untilText(new RegExp(`line-${n * 11}`));
    }
    const outputs = a.seen.filter((e): e is Extract<TerminalEvent, { type: "output" }> => e.type === "output");
    assert.deepEqual(
      outputs.map((e) => e.seq),
      outputs.map((_, i) => i + 1),
      "seq starts at 1 and grows by one per chunk",
    );
    const last = outputs.at(-1)!.seq;

    // Resume from the middle: only the later chunks, then control; no snapshot.
    const mid = outputs[0]!.seq;
    const resumed = new Reader(terminals.attach(info.id, { clientId: "b", resumeSeq: mid }));
    const replay: number[] = [];
    for (;;) {
      const event = await resumed.next();
      assert.ok(event && event.type !== "snapshot", "no snapshot on a successful resume");
      if (event.type === "control") break;
      assert.equal(event.type, "output");
      replay.push((event as { seq: number }).seq);
    }
    assert.deepEqual(replay, outputs.slice(1).map((e) => e.seq));

    // Up to date: nothing but control.
    const upToDate = new Reader(terminals.attach(info.id, { clientId: "c", resumeSeq: last }));
    assert.equal((await upToDate.next())?.type, "control");

    // A seq the terminal never produced: snapshot.
    const future = new Reader(terminals.attach(info.id, { clientId: "d", resumeSeq: last + 100 }));
    assert.equal((await future.next())?.type, "snapshot");

    // Live output after attaching continues the numbering on every stream.
    await a.att.input("echo after-$((2*21))\n", ctl.generation);
    const live = await resumed.until((e) => e.type === "output" && decode(e.data).includes("after-42"), "live output");
    assert.ok((live as { seq: number }).seq > last);
    await terminals.close(info.id);
  });

  test("a resume_seq that fell out of the replay buffer gets a snapshot", async () => {
    const terminals = manager({ replayBytes: 64 });
    const info = await terminals.create({ shell: SH, cwd: root, mode: "pipe" });
    const a = new Reader(terminals.attach(info.id, { mode: "control" }));
    await a.next();
    const ctl = await a.control();
    for (let i = 0; i < 6; i++) {
      await a.att.input(`echo chunk-${i}-0123456789abcdefghijklmnopqrstuvwxyz\n`, ctl.generation);
      await a.untilText(new RegExp(`chunk-${i}-0123`));
    }
    // Once parsed, old chunks are trimmed: seq 0 is no longer resumable.
    const { frame } = await snapshotWhen(terminals, info.id, (text) => text.includes("chunk-5"));
    assert.ok(frame.seq >= 6);
    const late = new Reader(terminals.attach(info.id, { resumeSeq: 0 }));
    assert.equal((await late.next())?.type, "snapshot");
    await terminals.close(info.id);
  });

  test("a subscriber that falls too far behind is dropped", async () => {
    const terminals = manager({ maxSubscriberBacklogBytes: 4096 });
    const info = await terminals.create({ shell: SH, args: ["-c", "i=0; while [ $i -lt 400 ]; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; sleep 30"], cwd: root, mode: "pipe" });
    const slow = terminals.attach(info.id);
    await sleep(1000);
    // It is no longer registered, and its iterator ends after the queued frames.
    assert.equal(terminals.get(info.id).viewers, 0);
    let frames = 0;
    for await (const _event of slow) frames++;
    assert.ok(frames > 0);
    await terminals.close(info.id);
  });
});

describe("TerminalManager: controller and viewers", { skip: IS_WINDOWS }, () => {
  test("claim, takeover, stale input, release, grace reconnect and expiry", async () => {
    const terminals = manager({ controlGraceMs: 300 });
    const info = await terminals.create({ shell: SH, cwd: root, mode: "pipe", cols: 80, rows: 24 });

    const a = new Reader(terminals.attach(info.id, { clientId: "client-a", label: "Laptop", mode: "control" }));
    assert.equal((await a.next())?.type, "snapshot");
    const aCtl = await a.control();
    assert.deepEqual({ you: aCtl.you, generation: aCtl.generation, id: aCtl.controller?.client_id, label: aCtl.controller?.label, connected: aCtl.controller?.connected }, { you: true, generation: 1, id: "client-a", label: "Laptop", connected: true });

    const b = new Reader(terminals.attach(info.id, { clientId: "client-b", label: "Phone" }));
    assert.equal((await b.next())?.type, "snapshot");
    const bCtl = await b.control();
    assert.equal(bCtl.you, false);
    assert.equal(bCtl.generation, 1);
    assert.equal(bCtl.controller?.client_id, "client-a");
    assert.equal(terminals.get(info.id).viewers, 2);

    // A viewer's input and resize are dropped; one `rejected` per generation.
    assert.equal(await b.att.input("echo from-b-$((1+1))\n", 1), false);
    assert.equal(b.att.resize(10, 10, 1), false);
    assert.equal(await b.att.input("echo again\n", 1), false);
    const bRej = await b.rejected();
    assert.deepEqual(bRej, { type: "rejected", reason: "not_controller", generation: 1 });
    assert.throws(() => terminals.resize(info.id, 10, 10, { clientId: "client-b" }), /not_controller/);
    assert.equal(terminals.get(info.id).cols, 80);

    assert.equal(await a.att.input("echo from-a-$((1+1))\n", 1), true);
    await a.untilText(/from-a-2/);

    // B takes over (keeping the size): both streams see generation 2.
    assert.equal(b.att.claim({ keepSize: true, cols: 20, rows: 5 }), true);
    const bNow = await b.control((e) => e.generation === 2);
    assert.equal(bNow.you, true);
    assert.equal(bNow.cols, 80, "keep_size keeps the current size");
    const aNow = await a.control((e) => e.generation === 2);
    assert.equal(aNow.you, false);
    assert.equal(aNow.controller?.client_id, "client-b");
    assert.ok(!b.seen.slice(b.seen.indexOf(bRej) + 1).some((e) => e.type === "rejected"), "only one rejected per generation");

    // A's in-flight keystrokes are dropped; B's stale-generation input too.
    assert.equal(await a.att.input("echo stale-a-$((1+1))\n", 1), false);
    assert.deepEqual(await a.rejected(), { type: "rejected", reason: "not_controller", generation: 2 });
    assert.equal(await b.att.input("echo stale-b\n", 1), false);
    assert.deepEqual(await b.rejected(), { type: "rejected", reason: "stale_generation", generation: 2 });
    assert.equal(await b.att.input("echo from-b-$((2+2))\n", 2), true);
    await b.untilText(/from-b-4/);
    assert.doesNotMatch(b.text, /stale-a-2|from-b-2/);

    // The unary path: only the controller's client id may resize.
    assert.throws(() => terminals.resize(info.id, 90, 30, { clientId: "client-a" }), /not_controller/);
    assert.equal(terminals.resize(info.id, 90, 30, { clientId: "client-b" }).cols, 90);
    assert.equal((await a.control((e) => e.cols === 90)).rows, 30);

    // Release by a non-controller is refused; by the controller clears control (generation 3).
    assert.equal(a.att.release(), false);
    assert.equal(b.att.release(), true);
    const cleared = await a.control((e) => e.generation === 3);
    assert.equal(cleared.controller, null);
    assert.equal(terminals.get(info.id).controller, null);
    assert.equal(a.att.release(), false);
    assert.deepEqual(await a.rejected(), { type: "rejected", reason: "not_controller", generation: 3 });

    // Grace: A claims (4), its stream ends, control is held disconnected; the same client reconnects (5).
    assert.equal(a.att.claim(), true);
    await b.control((e) => e.generation === 4);
    a.att.close();
    const held = await b.control((e) => e.controller?.connected === false);
    assert.equal(held.generation, 4);
    assert.equal(held.controller?.client_id, "client-a");
    assert.equal(terminals.get(info.id).viewers, 1);
    const a2 = new Reader(terminals.attach(info.id, { clientId: "client-a", label: "Laptop", mode: "control" }));
    assert.equal((await a2.next())?.type, "snapshot");
    const back = await a2.control();
    assert.deepEqual({ you: back.you, generation: back.generation, connected: back.controller?.connected }, { you: true, generation: 5, connected: true });
    assert.equal(await a2.att.input("echo back-$((3+3))\n", 5), true);
    await a2.untilText(/back-6/);

    // Grace expiry: nobody reconnects, control is cleared (6) and the size stays.
    a2.att.close();
    await b.control((e) => e.generation === 5 && e.controller?.connected === false);
    const expired = await b.control((e) => e.generation === 6);
    assert.equal(expired.controller, null);
    assert.equal(expired.cols, 90);
    assert.deepEqual(
      (({ controller, generation, viewers }) => ({ controller, generation, viewers }))(terminals.get(info.id)),
      { controller: null, generation: 6, viewers: 1 },
    );
    await terminals.close(info.id);
  });

  test("attach with mode=control never takes control from another client; only claim does", async () => {
    const terminals = manager({ controlGraceMs: 5000 });
    const info = await terminals.create({ shell: SH, cwd: root, mode: "pipe", cols: 80, rows: 24 });
    const a = new Reader(terminals.attach(info.id, { clientId: "client-a", mode: "control" }));
    assert.equal((await a.control()).generation, 1);
    const b = new Reader(terminals.attach(info.id, { clientId: "client-b" }));
    await b.control();
    assert.equal(b.att.claim(), true);
    await a.control((e) => e.generation === 2 && !e.you);

    // A's stream drops and A comes back with mode=control within B's tenure: A is a viewer, size untouched.
    a.att.close();
    const a2 = new Reader(terminals.attach(info.id, { clientId: "client-a", mode: "control", cols: 50, rows: 10 }));
    assert.equal((await a2.next())?.type, "snapshot");
    const a2Ctl = await a2.control();
    assert.deepEqual(
      { you: a2Ctl.you, generation: a2Ctl.generation, controller: a2Ctl.controller?.client_id, cols: a2Ctl.cols },
      { you: false, generation: 2, controller: "client-b", cols: 80 },
    );
    assert.equal(terminals.get(info.id).cols, 80);
    assert.equal(await a2.att.input("echo nope\n", 2), false);

    // B's stream drops: during its grace another client's mode=control is still only a viewer…
    b.att.close();
    await a2.control((e) => e.controller?.connected === false);
    const c = new Reader(terminals.attach(info.id, { clientId: "client-c", mode: "control" }));
    const cCtl = await c.control();
    assert.deepEqual({ you: cCtl.you, generation: cCtl.generation, controller: cCtl.controller?.client_id }, { you: false, generation: 2, controller: "client-b" });
    // …while B itself reconnecting with mode=control gets control back (generation + 1).
    const b2 = new Reader(terminals.attach(info.id, { clientId: "client-b", mode: "control" }));
    const b2Ctl = await b2.control();
    assert.deepEqual({ you: b2Ctl.you, generation: b2Ctl.generation, connected: b2Ctl.controller?.connected }, { you: true, generation: 3, connected: true });

    // An explicit claim is an unconditional takeover.
    assert.equal(a2.att.claim(), true);
    const taken = await b2.control((e) => e.generation === 4);
    assert.equal(taken.you, false);
    assert.equal(taken.controller?.client_id, "client-a");
    await terminals.close(info.id);
  });

  test("agent-owned terminals are read-only for everyone", async () => {
    const terminals = manager();
    const info = await terminals.create({ shell: SH, cwd: root, mode: "pipe", owner: "agent" });
    assert.equal(info.owner, "agent");
    const viewer = new Reader(terminals.attach(info.id, { clientId: "x", mode: "control" }));
    assert.equal((await viewer.next())?.type, "snapshot");
    const ctl = await viewer.control();
    assert.equal(ctl.controller, null);
    assert.deepEqual(await viewer.rejected(), { type: "rejected", reason: "agent_owned", generation: 0 });
    assert.equal(viewer.att.claim(), false);
    assert.equal(await viewer.att.input("echo nope\n", 0), false);
    assert.throws(() => terminals.resize(info.id, 10, 10, { clientId: "x" }), /agent_owned/);
    await terminals.close(info.id);
  });

  test("attaching to an exited terminal yields snapshot, control and exit", async () => {
    const terminals = manager();
    const info = await terminals.create({ shell: SH, args: ["-c", "echo bye-$((5*5)); exit 3"], cwd: root });
    const live = new Reader(terminals.attach(info.id));
    const exit = await live.until((e) => e.type === "exit", "exit");
    assert.deepEqual(exit, { type: "exit", exit_code: 3, exit_signal: null });
    const { frame, reader } = await snapshotWhen(terminals, info.id, (text) => text.includes("bye-25"));
    assert.ok(frame.seq >= 1);
    assert.equal((await reader.next())?.type, "control");
    assert.equal((await reader.next())?.type, "exit");
    assert.equal(await reader.next(), undefined);
    assert.equal(reader.att.claim(), false);
  });
});

describe("TerminalManager: fallback without node-pty", { skip: IS_WINDOWS }, () => {
  test("a failing loader falls back to pipes and reports the real mode", async () => {
    let loads = 0;
    const terminals = manager({
      fallbackMode: "pipe",
      loadPty: async () => {
        loads++;
        throw new Error("Cannot find module '@lydell/node-pty'");
      },
    });
    assert.equal(await terminals.ptyAvailable(), false);
    const info = await terminals.create({ shell: SH, cwd: root });
    assert.equal(info.mode, "pipe");
    const reader = new Reader(terminals.attach(info.id, { mode: "control" }));
    const ctl = await reader.control();
    await reader.att.input("echo term=$TERM; test -t 0 || echo notty-$((40+2))\n", ctl.generation);
    await reader.untilText(/notty-42/);
    assert.match(reader.text, /term=dumb/);
    const second = await terminals.create({ shell: SH, cwd: root, mode: "pty" });
    assert.equal(second.mode, "pipe");
    assert.equal(loads, 1, "the loader runs once per manager");
  });

  test("without an explicit fallback, Linux uses script(1) when available", async () => {
    const terminals = manager({ loadPty: async () => undefined });
    const info = await terminals.create({ shell: SH, cwd: root });
    if (process.platform === "linux") assert.ok(info.mode === "script" || info.mode === "pipe");
    else assert.equal(info.mode, "pipe");
  });

  test("an unknown shell fails in pty mode too", async () => {
    const terminals = manager();
    await assert.rejects(terminals.create({ shell: path.join(root, "no-such-shell"), cwd: root }), /spawn_failed/);
    await assert.rejects(terminals.create({ shell: "no-such-shell-aa-v3", cwd: root }), /spawn_failed/);
    assert.deepEqual(terminals.list(), []);
  });
});

describe("terminalClientIdentity", () => {
  const paired: PairedClientEntry[] = [{ client_pub: "K".repeat(43), label: "Alice phone", platform: "ios", paired_at: "2026-11-22T00:00:00.000Z" }];
  const gate = { listPairedClients: () => paired };

  test("E2E peers are keyed by their public key and named by the pairing record", () => {
    const key = "K".repeat(43);
    assert.deepEqual(terminalClientIdentity({ e2e: { peerKey: key } as never, tunnel: { id: "t", principal: "user:u1" } as never, tokenPrincipal: null }, gate, "spoofed"), {
      clientId: `e2e:${key}`,
      label: "Alice phone",
    });
    const stranger = "S".repeat(43);
    assert.deepEqual(terminalClientIdentity({ e2e: { peerKey: stranger } as never, tunnel: null, tokenPrincipal: null }, gate, "Laptop"), {
      clientId: `e2e:${stranger}`,
      label: "Laptop",
    });
  });

  test("tunnel principal, then token principal, then control; label from the request", () => {
    assert.deepEqual(terminalClientIdentity({ e2e: null, tunnel: { id: "t", principal: "user:u1/client:web" } as never, tokenPrincipal: "local:sdk" }, gate, "Chrome"), {
      clientId: "user:u1/client:web",
      label: "Chrome",
    });
    assert.deepEqual(terminalClientIdentity({ e2e: null, tunnel: null, tokenPrincipal: "local:sdk" }, gate), { clientId: "local:sdk", label: "local:sdk" });
    assert.deepEqual(terminalClientIdentity({ e2e: null, tunnel: null, tokenPrincipal: null }, gate, "  "), { clientId: "control", label: "control" });
  });
});
