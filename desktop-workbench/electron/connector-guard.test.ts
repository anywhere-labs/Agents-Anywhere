import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { test, type TestContext } from "node:test";
import { ConnectorGuard } from "./connector-guard";

const mac = { skip: process.platform !== "darwin", timeout: 10_000 };

const launcher = `
  const { spawn } = require("node:child_process");
  const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  process.on("SIGTERM", () => {});
  console.log(process.pid + " " + host.pid);
  setInterval(() => {}, 1000);
`;

async function start(t: TestContext, desktopPid: number, diagnostics: string[], script = launcher) {
  const guard = new ConnectorGuard({
    source: path.resolve(__dirname, "../connector-guard"),
    desktopPid,
    cwd: __dirname,
    executable: process.execPath,
    args: ["-e", script],
    env: process.env,
    onDiagnostic: line => diagnostics.push(line),
  });
  t.after(() => guard.stop());
  const lines = readline.createInterface({ input: guard.child.stdout });
  const ready = once(lines, "line");
  guard.start();
  try {
    const result = await Promise.race([ready, guard.closed.then(() => {
      throw new Error(`Launcher exited before readiness: ${diagnostics.join(", ")}`);
    })]);
    const [group, host] = String(result[0]).split(" ").map(Number);
    return { guard, group, host };
  } finally {
    lines.close();
  }
}

test("a dead Connector reaps the launcher even when the launcher ignores SIGTERM", mac, async t => {
  const diagnostics: string[] = [];
  const { guard, group, host } = await start(t, process.pid, diagnostics);
  guard.watch(host);
  process.kill(host, "SIGKILL");
  const result = await guard.closed;
  assert.equal(result.cleaned, true);
  assert.equal(result.code, 137);
  assert.match(diagnostics.join("\n"), /connector-(exited|unavailable)/);
  assert.throws(() => process.kill(group, 0), { code: "ESRCH" });
});

test("Electron exit reaps the Connector while the backend control channel is still open", mac, async t => {
  const main = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => { main.kill("SIGKILL"); });
  const diagnostics: string[] = [];
  const { guard, group } = await start(t, main.pid!, diagnostics);
  main.kill("SIGKILL");
  assert.equal((await guard.closed).cleaned, true);
  assert.match(diagnostics.join("\n"), /desktop-exited/);
  assert.throws(() => process.kill(group, 0), { code: "ESRCH" });
});


test("cleanup completes while a separate process group still holds stdout", mac, async t => {
  const detachedLauncher = `
    const { spawn } = require("node:child_process");
    const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.log(process.pid + " " + detached.pid);
    setInterval(() => {}, 1000);
  `;
  const { guard, group, host } = await start(t, process.pid, [], detachedLauncher);
  t.after(() => {
    try { process.kill(host, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  });
  await guard.stop();
  assert.doesNotThrow(() => process.kill(host, 0));
  assert.throws(() => process.kill(group, 0), { code: "ESRCH" });
});
