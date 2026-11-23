import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  DeviceOpsError,
  getDeviceStatus,
  gitDiff,
  gitStatus,
  listDirs,
  parsePorcelainV1,
  readFile,
  sanitizeFileName,
  saveAttachment,
  writeFile,
} from "../src/runtime/device-ops.js";
import {
  DEFAULT_MAX_RPC_FILE_BYTES,
  StateStore,
  StateStoreError,
  type PairedClientEntry,
} from "../src/runtime/state-store.js";
import { TerminalManager, type TerminalEvent, type TerminalMode } from "../src/runtime/terminal-manager.js";

const IS_WINDOWS = process.platform === "win32";
const KEY_A = "A".repeat(43);
const KEY_B = "b_-".repeat(14) + "c";

let root: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aa-v3-wave1b-"));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(root, `${name}-`));
}

async function fileMode(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

describe("StateStore", () => {
  test("identity round-trips and is stored with 0600 permissions", async () => {
    const store = new StateStore({ dataDir: path.join(await freshDir("state"), "nested", "dir") });
    assert.equal(await store.loadIdentity(), null);

    const identity = {
      device_id: "dev_123",
      device_secret: "aad_secret_value",
      control_url: "https://aa.example.test",
      e2e_private_key: KEY_A,
      e2e_public_key: KEY_B,
    };
    await store.saveIdentity(identity);
    assert.deepEqual(await store.loadIdentity(), identity);

    if (!IS_WINDOWS) {
      assert.equal(await fileMode(store.pathFor("identity.json")), 0o600);
      assert.equal(await fileMode(store.dataDir), 0o700);
      // A loosened identity file is tightened back on load.
      await fs.chmod(store.pathFor("identity.json"), 0o644);
      await store.loadIdentity();
      assert.equal(await fileMode(store.pathFor("identity.json")), 0o600);
    }

    // No temp files are left behind by atomic writes.
    const files = await fs.readdir(store.dataDir);
    assert.deepEqual(files, ["identity.json"]);
  });

  test("identity validation rejects malformed keys", async () => {
    const store = new StateStore({ dataDir: await freshDir("state") });
    await assert.rejects(
      store.saveIdentity({ device_id: "d", device_secret: "s", control_url: "u", e2e_public_key: "short" }),
      (err: unknown) => err instanceof StateStoreError && err.code === "state_value_invalid",
    );
    await fs.writeFile(store.pathFor("identity.json"), "{not json");
    await assert.rejects(store.loadIdentity(), (err: unknown) => err instanceof StateStoreError && err.code === "state_file_invalid");
  });

  test("settings have safe defaults and persist updates", async () => {
    const store = new StateStore({ dataDir: await freshDir("state") });
    const defaults = await store.loadSettings();
    assert.equal(defaults.mode, "normal");
    assert.equal(defaults.allow_mcp, false);
    assert.equal(defaults.require_pairing_confirm, false);
    assert.equal(defaults.max_rpc_file_bytes, DEFAULT_MAX_RPC_FILE_BYTES);
    assert.ok(defaults.device_name.length > 0);

    const updated = await store.updateSettings({ mode: "encrypted", device_name: "Studio Mac" });
    assert.equal(updated.mode, "encrypted");
    assert.deepEqual(await new StateStore({ dataDir: store.dataDir }).loadSettings(), updated);

    await store.saveSettings({ ...updated, allow_mcp: true, max_rpc_file_bytes: 1024 });
    const reloaded = await store.loadSettings();
    assert.equal(reloaded.allow_mcp, true);
    assert.equal(reloaded.max_rpc_file_bytes, 1024);
    if (!IS_WINDOWS) assert.equal(await fileMode(store.pathFor("settings.json")), 0o600);

    // Missing fields fall back to defaults (forward compatibility)...
    await fs.writeFile(store.pathFor("settings.json"), JSON.stringify({ mode: "encrypted" }));
    assert.equal((await store.loadSettings()).allow_mcp, false);
    // ...but a present-but-invalid mode never silently downgrades to "normal".
    await fs.writeFile(store.pathFor("settings.json"), JSON.stringify({ mode: "plaintext" }));
    await assert.rejects(store.loadSettings(), /state_file_invalid/);
  });

  test("concurrent saves land in call order", async () => {
    const store = new StateStore({ dataDir: await freshDir("state") });
    const base = await store.loadSettings();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.saveSettings({ ...base, max_rpc_file_bytes: 1000 + i })),
    );
    assert.equal((await store.loadSettings()).max_rpc_file_bytes, 1009);
  });

  test("paired clients persist and invalid entries fail closed", async () => {
    const store = new StateStore({ dataDir: await freshDir("state") });
    assert.deepEqual(await store.loadPairedClients(), []);

    const clients: PairedClientEntry[] = [
      { client_pub: KEY_A, label: "iPhone", platform: "ios", paired_at: "2026-11-21T10:00:00.000Z" },
      {
        client_pub: KEY_B,
        label: "Browser",
        platform: "web",
        paired_at: "2026-11-21T11:00:00.000Z",
        last_seen_at: "2026-11-21T12:00:00.000Z",
      },
    ];
    await store.savePairedClients(clients);
    assert.deepEqual(await store.loadPairedClients(), clients);

    await assert.rejects(store.savePairedClients([clients[0]!, clients[0]!]), /duplicate client_pub/);
    await fs.writeFile(
      store.pathFor("paired-clients.json"),
      JSON.stringify([{ client_pub: "nope", label: "x", platform: "ios", paired_at: "2026-11-21T10:00:00Z" }]),
    );
    await assert.rejects(store.loadPairedClients(), /state_file_invalid/);
  });

  test("sessions snapshot round-trips opaque JSON", async () => {
    const store = new StateStore({ dataDir: await freshDir("state") });
    assert.deepEqual(await store.loadSessionsSnapshot(), []);
    const snapshot = [{ id: "s1", title: "你好", nested: { n: 1 } }, { id: "s2" }];
    await store.saveSessionsSnapshot(snapshot);
    assert.deepEqual(await store.loadSessionsSnapshot(), snapshot);
    await fs.writeFile(store.pathFor("sessions.json"), "{}");
    await assert.rejects(store.loadSessionsSnapshot(), /must be a JSON array/);
  });
});

// ---------------------------------------------------------------------------
// device-ops
// ---------------------------------------------------------------------------

describe("device-ops", () => {
  test("getDeviceStatus reports contract-compatible fields", () => {
    const status = getDeviceStatus({ connectorVersion: "3.0.0-alpha.1", startedAt: Date.now() - 5000 });
    assert.ok(["macos", "linux", "windows"].includes(status.platform));
    assert.equal(status.connector_version, "3.0.0-alpha.1");
    assert.equal(status.node_version, process.version);
    assert.ok(status.uptime_seconds >= 4 && status.uptime_seconds <= 10);
    assert.equal(typeof status.hostname, "string");
  });

  test("listDirs lists files and directories, directories first", async () => {
    const dir = await freshDir("list");
    await fs.mkdir(path.join(dir, "zeta-dir"));
    await fs.writeFile(path.join(dir, "alpha.txt"), "12345");
    const result = await listDirs(dir);
    assert.equal(result.path, dir);
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.entries.map((e) => [e.name, e.is_dir]),
      [
        ["zeta-dir", true],
        ["alpha.txt", false],
      ],
    );
    const file = result.entries[1]!;
    assert.equal(file.size, 5);
    assert.equal(file.path, path.join(dir, "alpha.txt"));
    assert.ok(file.mtime && !Number.isNaN(Date.parse(file.mtime)));

    const limited = await listDirs(dir, { maxEntries: 1 });
    assert.equal(limited.entries.length, 1);
    assert.equal(limited.truncated, true);

    const home = await listDirs();
    assert.equal(home.path, os.homedir());
  });

  test("listDirs rejects NUL bytes and maps missing / non-directory paths", async () => {
    const dir = await freshDir("list");
    await fs.writeFile(path.join(dir, "file"), "x");
    await assert.rejects(listDirs(`${dir}\0evil`), (err: unknown) => err instanceof DeviceOpsError && err.code === "invalid_path");
    await assert.rejects(listDirs(path.join(dir, "missing")), { code: "not_found" });
    await assert.rejects(listDirs(path.join(dir, "file")), { code: "not_a_directory" });
  });

  test("listDirs reports permission errors cleanly", { skip: IS_WINDOWS || process.getuid?.() === 0 }, async () => {
    const dir = await freshDir("list");
    const locked = path.join(dir, "locked");
    await fs.mkdir(locked, { mode: 0o000 });
    try {
      await assert.rejects(listDirs(locked), { code: "permission_denied" });
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });

  test("writeFile + readFile handle text, binary, and slices", async () => {
    const dir = await freshDir("rw");
    const textPath = path.join(dir, "deep", "nested", "note.md");
    const written = await writeFile(textPath, "# 标题\nhello\n");
    assert.equal(written.size, Buffer.byteLength("# 标题\nhello\n"));
    const text = await readFile(textPath);
    assert.equal(text.encoding, "utf8");
    assert.equal(text.content, "# 标题\nhello\n");
    assert.equal(text.eof, true);

    const binPath = path.join(dir, "blob.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 10]);
    await writeFile(binPath, bytes.toString("base64"), "base64");
    const bin = await readFile(binPath);
    assert.equal(bin.encoding, "base64");
    assert.deepEqual(Buffer.from(bin.content, "base64"), bytes);

    const slice = await readFile(binPath, { offsetBytes: 3, maxBytes: 2 });
    assert.equal(slice.offset, 3);
    assert.equal(slice.bytes_read, 2);
    assert.equal(slice.eof, false);
    assert.deepEqual(Buffer.from(slice.content, "base64"), bytes.subarray(3, 5));

    // Overwrite preserves the existing file mode.
    if (!IS_WINDOWS) {
      await fs.chmod(textPath, 0o640);
      await writeFile(textPath, "changed");
      assert.equal(await fileMode(textPath), 0o640);
    }
    assert.deepEqual(await fs.readdir(path.dirname(textPath)), ["note.md"]);

    await assert.rejects(writeFile(dir, "x"), { code: "is_a_directory" });
    await assert.rejects(readFile(dir), { code: "is_a_directory" });
    await assert.rejects(writeFile(binPath, "@@not base64@@", "base64"), { code: "invalid_encoding" });
  });

  test("readFile enforces maxRpcFileBytes unless a bounded slice is requested", async () => {
    const dir = await freshDir("cap");
    const big = path.join(dir, "big.txt");
    await fs.writeFile(big, "x".repeat(4096));

    await assert.rejects(readFile(big, { maxRpcFileBytes: 1024 }), (err: unknown) => {
      assert.ok(err instanceof DeviceOpsError);
      assert.equal(err.code, "file_too_large_for_rpc");
      assert.match(err.message, /^file_too_large_for_rpc/);
      return true;
    });

    const head = await readFile(big, { maxRpcFileBytes: 1024, maxBytes: 100 });
    assert.equal(head.bytes_read, 100);
    // A slice request is still clamped to the cap.
    const clamped = await readFile(big, { maxRpcFileBytes: 1024, offsetBytes: 0, maxBytes: 999_999 });
    assert.equal(clamped.bytes_read, 1024);
    assert.equal(clamped.size, 4096);

    await assert.rejects(writeFile(path.join(dir, "out.txt"), "y".repeat(2048), "utf8", 1024), {
      code: "file_too_large_for_rpc",
    });
    await assert.rejects(writeFile(path.join(dir, "out.bin"), Buffer.alloc(2048).toString("base64"), "base64", 1024), {
      code: "file_too_large_for_rpc",
    });
  });

  describe("git", () => {
    let repo: string;
    let gitEnv: NodeJS.ProcessEnv;
    const savedEnv: Record<string, string | undefined> = {};

    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).toString();

    before(async () => {
      repo = await freshDir("repo");
      const emptyConfig = path.join(root, "empty-gitconfig");
      await fs.writeFile(emptyConfig, "");
      // Isolate from the developer's global git config (signing, hooks, ...).
      for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) savedEnv[key] = process.env[key];
      process.env.GIT_CONFIG_GLOBAL = emptyConfig;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "AA Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "AA Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      };
      git("init", "-q");
      git("symbolic-ref", "HEAD", "refs/heads/main");
    });

    after(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    test("gitStatus reports a clean non-repo and an unborn branch", async () => {
      const plain = await freshDir("plain");
      assert.deepEqual(await gitStatus(plain), { is_repo: false });
      assert.deepEqual(await gitDiff(plain), { is_repo: false });
      await assert.rejects(gitStatus(path.join(plain, "missing")), { code: "not_found" });

      const status = await gitStatus(repo);
      assert.ok(status.is_repo);
      assert.equal(status.branch, "main");
      assert.equal(status.clean, true);
    });

    test("gitStatus parses staged, modified, untracked, and renamed entries", async () => {
      await fs.writeFile(path.join(repo, "tracked.txt"), "one\n");
      await fs.writeFile(path.join(repo, "to rename.txt"), "rename me\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");

      await fs.writeFile(path.join(repo, "tracked.txt"), "one\ntwo\n");
      await fs.writeFile(path.join(repo, "staged.txt"), "staged\n");
      git("add", "staged.txt");
      git("mv", "to rename.txt", "renamed file.txt");
      await fs.writeFile(path.join(repo, "untracked.txt"), "new\n");

      const status = await gitStatus(repo);
      assert.ok(status.is_repo);
      assert.equal(status.branch, "main");
      assert.equal(status.detached, false);
      assert.equal(status.clean, false);
      assert.deepEqual(status.modified, ["tracked.txt"]);
      assert.deepEqual(status.untracked, ["untracked.txt"]);
      assert.deepEqual([...status.staged].sort(), ["renamed file.txt", "staged.txt"]);
      const rename = status.entries.find((e) => e.index === "R");
      assert.equal(rename?.path, "renamed file.txt");
      assert.equal(rename?.orig_path, "to rename.txt");
    });

    test("gitDiff returns unstaged / staged diffs and truncates on line boundaries", async () => {
      const unstaged = await gitDiff(repo);
      assert.ok(unstaged.is_repo);
      assert.equal(unstaged.truncated, false);
      assert.match(unstaged.diff, /^\+two$/m);
      assert.doesNotMatch(unstaged.diff, /staged\.txt/);

      const staged = await gitDiff(repo, { staged: true, filePath: "staged.txt" });
      assert.ok(staged.is_repo);
      assert.match(staged.diff, /\+\+\+ b\/staged\.txt/);
      assert.doesNotMatch(staged.diff, /renamed/);

      const truncated = await gitDiff(repo, { maxBytes: 40 });
      assert.ok(truncated.is_repo);
      assert.equal(truncated.truncated, true);
      assert.ok(truncated.bytes <= 40);
      assert.ok(truncated.diff.endsWith("\n"));

      // Option-looking paths stay paths after `--`.
      const odd = await gitDiff(repo, { filePath: "--output=/tmp/aa-should-not-exist" });
      assert.ok(odd.is_repo);
      assert.equal(odd.diff, "");
    });
  });

  test("parsePorcelainV1 handles tracking info, detached HEAD, and conflicts", () => {
    const tracked = parsePorcelainV1("## main...origin/main [ahead 2, behind 1]\0UU both.txt\0 M a.txt\0");
    assert.equal(tracked.branch, "main");
    assert.equal(tracked.upstream, "origin/main");
    assert.equal(tracked.ahead, 2);
    assert.equal(tracked.behind, 1);
    assert.deepEqual(tracked.conflicted, ["both.txt"]);
    assert.deepEqual(tracked.modified, ["a.txt"]);

    const detached = parsePorcelainV1("## HEAD (no branch)\0");
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, null);
  });

  test("saveAttachment enforces size and sanitizes names", async () => {
    const dataDir = await freshDir("attach");
    const payload = Buffer.from("attachment body");
    const saved = await saveAttachment(dataDir, {
      name: "../../etc/pass wd:<x>.txt",
      base64: payload.toString("base64"),
    });
    assert.equal(saved.name, "pass wd_x_.txt");
    assert.equal(saved.mime, "text/plain");
    assert.equal(saved.size, payload.byteLength);
    assert.equal(path.dirname(saved.path), path.join(dataDir, "attachments", "unsorted"));
    assert.ok(path.basename(saved.path).endsWith(`-${saved.name}`));
    assert.deepEqual(await fs.readFile(saved.path), payload);
    if (!IS_WINDOWS) assert.equal(await fileMode(saved.path), 0o600);

    const png = await saveAttachment(dataDir, { name: "截图.png", base64: "AAAA", mime: "image/png" });
    assert.equal(png.name, "截图.png");
    assert.equal(png.mime, "image/png");

    await assert.rejects(
      saveAttachment(dataDir, { name: "big.bin", base64: Buffer.alloc(2048).toString("base64"), maxBytes: 1024 }),
      { code: "attachment_too_large" },
    );
    await assert.rejects(saveAttachment(dataDir, { name: "bad", base64: "!!!" }), { code: "invalid_encoding" });

    assert.equal(sanitizeFileName(".."), "attachment");
    assert.equal(sanitizeFileName(".hidden"), "hidden");
  });
});

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

const TEST_SHELL = IS_WINDOWS ? undefined : "/bin/sh";

/** Collect subscription output until `predicate` matches or the stream ends. */
async function collectUntil(
  events: AsyncIterableIterator<TerminalEvent>,
  predicate: (text: string, exited: boolean) => boolean,
  timeoutMs = 10_000,
): Promise<{ text: string; exitCode: number | null | undefined }> {
  let text = "";
  let exitCode: number | null | undefined;
  const timer = setTimeout(() => void events.return?.(), timeoutMs);
  try {
    for await (const event of events) {
      if (event.type === "output" || event.type === "snapshot") text += Buffer.from(event.data, "base64").toString("utf8");
      else if (event.type === "exit") exitCode = event.exit_code;
      if (predicate(text, exitCode !== undefined)) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return { text, exitCode };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describe("TerminalManager", () => {
  test("runs a command, streams output, replays history, and closes", async () => {
    const manager = new TerminalManager({ killGraceMs: 500 });
    const cwd = await freshDir("term");
    try {
      const info = await manager.create({ shell: TEST_SHELL, cwd, cols: 100, rows: 30 });
      assert.equal(info.running, true);
      assert.equal(info.cwd, cwd);
      assert.equal(info.cols, 100);
      assert.ok(info.pid);
      assert.deepEqual(
        manager.list().map((t) => t.id),
        [info.id],
      );

      const live = manager.attach(info.id);
      await manager.write(info.id, "echo hello-aa-v3\n");
      const { text } = await collectUntil(live, (t) => t.includes("hello-aa-v3"));
      assert.match(text, /hello-aa-v3/);
      await live.return?.();

      // A late subscriber starts with a snapshot of the screen (retry: the emulator parses asynchronously).
      let late = manager.attach(info.id);
      for (let attempt = 0; ; attempt++) {
        const first = await late.next();
        assert.equal(first.done, false);
        assert.ok(first.value?.type === "snapshot");
        if (/hello-aa-v3/.test(Buffer.from(first.value.data, "base64").toString("utf8"))) break;
        assert.ok(attempt < 100, "snapshot never contained the output");
        await late.return?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        late = manager.attach(info.id);
      }

      const resized = manager.resize(info.id, 120, 40);
      assert.equal(resized.cols, 120);
      assert.equal(resized.rows, 40);
      assert.throws(() => manager.resize(info.id, 0, 40), /invalid_argument/);

      await manager.close(info.id);
      // The open subscription ends with an exit event.
      const rest = await collectUntil(late, (_t, exited) => exited, 5000);
      assert.notEqual(rest.exitCode, undefined);
      assert.equal(await waitForDeath(info.pid!), true);
      assert.deepEqual(manager.list(), []);
      assert.throws(() => manager.attach(info.id), /terminal_not_found/);
    } finally {
      await manager.closeAll();
    }
  });

  test("reports natural exit with the exit code", async () => {
    const manager = new TerminalManager();
    try {
      const info = await manager.create({ shell: TEST_SHELL, cwd: await freshDir("term") });
      const events = manager.attach(info.id);
      await manager.write(info.id, "exit 7\n");
      const { exitCode } = await collectUntil(events, (_t, exited) => exited);
      assert.equal(exitCode, 7);
      const exited = manager.get(info.id);
      assert.equal(exited.running, false);
      assert.equal(exited.exit_code, 7);
      await assert.rejects(manager.write(info.id, "echo nope\n"), /terminal_not_running/);

      // Attaching after exit yields the snapshot, control, then the exit event.
      const replay = await collectUntil(manager.attach(info.id), () => false);
      assert.equal(replay.exitCode, 7);
    } finally {
      await manager.closeAll();
    }
  });

  test("rejects bad cwd and unknown shells", async () => {
    const manager = new TerminalManager();
    try {
      await assert.rejects(manager.create({ cwd: path.join(root, "does-not-exist") }), /invalid_argument/);
      await assert.rejects(manager.create({ shell: path.join(root, "no-such-shell") }), /spawn_failed/);
      assert.deepEqual(manager.list(), []);
    } finally {
      await manager.closeAll();
    }
  });

  for (const mode of ["pty", "pipe"] satisfies TerminalMode[]) test(`closeAll leaves no child processes behind (${mode})`, { skip: IS_WINDOWS }, async () => {
    const manager = new TerminalManager({ killGraceMs: 500 });
    const pids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const info = await manager.create({ shell: TEST_SHELL, cwd: await freshDir("term"), mode });
      pids.push(info.pid!);
      const events = manager.attach(info.id);
      // A background job keeps running after the shell exits unless the
      // whole process group is killed.
      await manager.write(info.id, "sleep 60 & echo bgpid=$!\n");
      const { text } = await collectUntil(events, (t) => /bgpid=\d+\r?\n/.test(t));
      const bg = Number(/bgpid=(\d+)\r?\n/.exec(text)?.[1]);
      assert.ok(bg > 0, `expected a background pid in ${JSON.stringify(text)}`);
      pids.push(bg);
      await events.return?.();
    }
    assert.ok(pids.every(isAlive));

    await manager.closeAll();
    for (const pid of pids) assert.equal(await waitForDeath(pid), true, `pid ${pid} still alive`);
    assert.deepEqual(manager.list(), []);
    await assert.rejects(manager.create({ shell: TEST_SHELL }), /terminal_manager_closed/);
  });

  test("script mode provides a pty on Linux and is refused elsewhere", async () => {
    const manager = new TerminalManager({ killGraceMs: 500 });
    try {
      const cwd = await freshDir("term");
      if (process.platform !== "linux") {
        await assert.rejects(manager.create({ shell: TEST_SHELL, cwd, mode: "script" }), /invalid_argument/);
        return;
      }
      const info = await manager.create({ shell: TEST_SHELL, cwd, mode: "script" });
      const events = manager.attach(info.id);
      // `test -t 0` succeeds only when stdin is a terminal; arithmetic keeps the
      // tty's input echo from matching the expected output.
      await manager.write(info.id, "test -t 0 && echo tty-$((40+2)) || echo notty-$((40+2))\n");
      const { text } = await collectUntil(events, (t) => /(no)?tty-42/.test(t));
      assert.match(text, /\btty-42/);
      await events.return?.();
      await manager.close(info.id);
      assert.equal(await waitForDeath(info.pid!), true);
    } finally {
      await manager.closeAll();
    }
  });
});
