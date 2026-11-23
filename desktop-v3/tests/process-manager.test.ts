import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { backoffDelay, DEFAULT_BACKOFF, ManagedProcess } from "../src/main/process-manager";
import type { ProcessStatus } from "../src/shared/bridge";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aa-dv3-pm-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function nodeProcess(name: string, script: string, extra: Partial<ConstructorParameters<typeof ManagedProcess>[0]> = {}) {
  return new ManagedProcess({
    name,
    command: process.execPath,
    args: ["-e", script],
    logFile: path.join(tmp, `${name}.log`),
    backoff: { initialMs: 20, maxMs: 80, factor: 2, resetAfterMs: 10_000, maxAttempts: 0 },
    stopTimeoutMs: 2_000,
    ...extra,
  });
}

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    const opts = { ...DEFAULT_BACKOFF, initialMs: 1000, factor: 2, maxMs: 5000 };
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffDelay(n, opts)), [1000, 2000, 4000, 5000, 5000]);
  });
});

describe("ManagedProcess", () => {
  it("runs a process, writes its output to the log, and stops it", async () => {
    const proc = nodeProcess("long", "console.log('hello ' + 'from child'); setInterval(() => {}, 1000)");
    proc.start();
    await waitFor(() => proc.status.state === "running");
    const pid = proc.status.pid;
    assert.ok(pid);
    await waitFor(() => existsSync(proc.options.logFile) && readFileSync(proc.options.logFile, "utf8").includes("hello from child"));
    await proc.stop();
    assert.equal(proc.status.state, "stopped");
    assert.equal(proc.status.pid, null);
    assert.throws(() => process.kill(pid!, 0));
    await proc.closeLog();
  });

  it("restarts a crashing process with backoff", async () => {
    const proc = nodeProcess("crash", "process.exit(3)");
    const states: string[] = [];
    proc.on("status", (s: ProcessStatus) => states.push(s.state));
    proc.start();
    await waitFor(() => proc.status.restarts >= 3);
    await proc.stop();
    assert.match(readFileSync(proc.options.logFile, "utf8"), /exited \(code 3\)/);
    assert.ok(states.includes("backoff"));
    assert.equal(proc.status.state, "stopped");
    await proc.closeLog();
  });

  it("gives up after maxAttempts consecutive failures", async () => {
    const proc = nodeProcess("giveup", "process.exit(1)", {
      backoff: { initialMs: 10, maxMs: 10, factor: 1, resetAfterMs: 10_000, maxAttempts: 2 },
    });
    proc.start();
    await waitFor(() => proc.status.state === "failed");
    assert.equal(proc.status.restarts, 2);
    await proc.closeLog();
  });

  it("does not restart after stop()", async () => {
    const proc = nodeProcess("nostart", "setInterval(() => {}, 1000)");
    proc.start();
    await waitFor(() => proc.status.state === "running");
    await proc.stop();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(proc.status.state, "stopped");
    assert.equal(proc.status.restarts, 0);
    await proc.closeLog();
  });

  it("kills a process that ignores SIGTERM after the stop timeout", async () => {
    const proc = nodeProcess("stubborn", "process.on('SIGTERM', () => {}); console.log('RE' + 'ADY'); setInterval(() => {}, 1000)", {
      stopTimeoutMs: 300,
    });
    proc.start();
    await waitFor(() => existsSync(proc.options.logFile) && readFileSync(proc.options.logFile, "utf8").includes("READY"));
    const started = Date.now();
    await proc.stop();
    assert.ok(Date.now() - started >= 250);
    assert.equal(proc.status.state, "stopped");
    await proc.closeLog();
  });

  it("restarts the process when the health check keeps failing", async () => {
    let healthy = true;
    const proc = nodeProcess("health", "setInterval(() => {}, 1000)", {
      health: { check: async () => healthy, intervalMs: 30, startupGraceMs: 0, failuresBeforeRestart: 2 },
    });
    proc.start();
    await waitFor(() => proc.status.state === "running");
    const firstPid = proc.status.pid;
    healthy = false;
    await waitFor(() => proc.status.restarts >= 1 && proc.status.state === "running" && proc.status.pid !== firstPid);
    healthy = true;
    assert.match(proc.status.lastError ?? "", /health check failed/);
    await proc.stop();
    await proc.closeLog();
  });

  it("reads the environment at spawn time when given a function", async () => {
    let value = "first";
    const proc = nodeProcess("env", "console.log('VALUE=' + process.env.AA_TEST_VALUE); setInterval(() => {}, 1000)", {
      env: () => ({ ...process.env, AA_TEST_VALUE: value }),
    });
    value = "second";
    proc.start();
    await waitFor(() => existsSync(proc.options.logFile) && readFileSync(proc.options.logFile, "utf8").includes("VALUE=second"));
    await proc.stop();
    await proc.closeLog();
  });

  it("rotates the log file when it grows past the limit", async () => {
    const proc = nodeProcess("rotate", "for (let i = 0; i < 50; i++) console.log('x'.repeat(100)); setInterval(() => {}, 1000)", {
      maxLogBytes: 1_000,
    });
    proc.start();
    await waitFor(() => existsSync(`${proc.options.logFile}.1`));
    await proc.stop();
    await proc.closeLog();
  });

  it("reports a spawn failure and retries", async () => {
    const proc = new ManagedProcess({
      name: "missing",
      command: path.join(tmp, "does-not-exist"),
      args: [],
      logFile: path.join(tmp, "missing.log"),
      backoff: { initialMs: 10, maxMs: 10, factor: 1, resetAfterMs: 10_000, maxAttempts: 1 },
    });
    proc.start();
    await waitFor(() => proc.status.state === "failed");
    assert.match(proc.status.lastError ?? "", /ENOENT/);
    await proc.closeLog();
  });
});
