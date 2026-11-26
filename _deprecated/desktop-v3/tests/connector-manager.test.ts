import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { adminCall, adminSocketPath } from "../src/main/admin-client";
import { ConnectorManager } from "../src/main/connector-manager";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aa-dv3-cm-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A stand-in for the bundled connector CLI: `register` writes identity.json, `start` serves the admin socket.
const FAKE_ENTRY = `
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = path.resolve(opt("--data-dir"));
mkdirSync(dataDir, { recursive: true });
appendFileSync(path.join(dataDir, "calls.log"), JSON.stringify({ args, token: process.env.AA_ACCESS_TOKEN ?? null, electronAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }) + "\\n");

function socketPath() {
  const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  if (process.platform === "win32") return "\\\\\\\\.\\\\pipe\\\\aa-connector-" + hash;
  const inside = path.join(dataDir, "admin.sock");
  return Buffer.byteLength(inside) < 100 ? inside : path.join(os.tmpdir(), "aa-connector-" + hash + ".sock");
}

if (cmd === "register") {
  if (process.env.AA_ACCESS_TOKEN !== "good-token") { console.error("aa-connector: HTTP 401 invalid token"); process.exit(1); }
  writeFileSync(path.join(dataDir, "identity.json"), JSON.stringify({ device_id: "dev_test", control_url: opt("--control-url") }));
  writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ device_name: opt("--name"), mode: opt("--mode") }));
  console.log("registered");
} else if (cmd === "start") {
  console.log("fake connector started");
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (c) => {
      buf += c;
      if (!buf.includes("\\n")) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf("\\n")));
      let result;
      if (req.cmd === "status") result = { device_id: "dev_test", mode: "normal", serving: true, local_router: { url: "ws://127.0.0.1:1234", http_url: "http://127.0.0.1:1234", started_at: "x" }, settings: {}, runtimes: [{ id: "pi", name: "Pi" }], paired_clients: 0, sessions: 0 };
      else if (req.cmd === "pair") result = { uri: "aa-pair://v1/test-" + (req.label ?? ""), expires_at: "2030-01-01T00:00:00Z", pairing_id: "p1" };
      socket.end(JSON.stringify(result ? { ok: true, result } : { ok: false, error: "unknown" }) + "\\n");
    });
  });
  server.listen(socketPath());
  const stop = () => { server.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
`;

function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await pred()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

function makeManager(name: string) {
  const entry = path.join(tmp, `${name}-entry.mjs`);
  writeFileSync(entry, FAKE_ENTRY);
  const dataDir = path.join(tmp, name, "data");
  return new ConnectorManager({
    entry,
    execPath: process.execPath,
    dataDir,
    logDir: path.join(tmp, name, "logs"),
    env: () => ({ ...process.env, AA_ACCESS_TOKEN: "must-not-leak" }),
    resolveControlUrl: (url) => (url.startsWith("/") ? "http://control.test" : url),
  });
}

const calls = (dataDir: string) =>
  readFileSync(path.join(dataDir, "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { args: string[]; token: string | null; electronAsNode: string | null });

describe("ConnectorManager", () => {
  it("starts the connector in Local-First mode and reports its status", async () => {
    const manager = makeManager("start");
    manager.start();
    await waitFor(async () => (await manager.status()).localRouter !== null);
    const status = await manager.status();
    assert.equal(status.connector.state, "running");
    assert.equal(status.registered, false);
    assert.deepEqual(status.runtimes, [{ id: "pi", name: "Pi" }]);
    assert.deepEqual(status.localRouter, { url: "ws://127.0.0.1:1234", httpUrl: "http://127.0.0.1:1234" });
    const [start] = calls(manager.options.dataDir);
    assert.deepEqual(start!.args.slice(0, 4), ["start", "--data-dir", manager.options.dataDir, "--local-router"]);
    assert.equal(start!.token, null, "the access token is never passed to the long-running connector");
    assert.equal(start!.electronAsNode, "1");
    assert.match(await manager.logs(10), /fake connector started/);
    await manager.stop();
    assert.equal((await manager.status()).connector.state, "stopped");
  });

  it("registers through the CLI with the token in the environment, then restarts", async () => {
    const manager = makeManager("register");
    manager.start();
    await waitFor(() => manager.process.status.state === "running");
    const status = await manager.register({ controlUrl: "/api/control", accessToken: "good-token", name: "Desktop v3 test", mode: "encrypted" });
    assert.equal(status.registered, true);
    assert.equal(status.deviceId, "dev_test");
    assert.equal(status.controlUrl, "http://control.test");
    assert.equal(status.deviceName, "Desktop v3 test");
    const register = calls(manager.options.dataDir).find((c) => c.args[0] === "register")!;
    assert.ok(!register.args.includes("good-token"), "token must not appear in argv");
    assert.equal(register.token, "good-token");
    assert.ok(register.args.includes("--mode") && register.args.includes("encrypted"));
    await waitFor(() => manager.process.status.state === "running");
    await assert.rejects(manager.register({ controlUrl: "/api/control", accessToken: "good-token", name: "x", mode: "normal" }), /already registered/);
    await manager.stop();
  });

  it("surfaces CLI errors and keeps the connector running", async () => {
    const manager = makeManager("register-fail");
    await assert.rejects(
      manager.register({ controlUrl: "https://aa.example.com", accessToken: "bad", name: "x", mode: "normal" }),
      /HTTP 401 invalid token/,
    );
    await waitFor(() => manager.process.status.state === "running");
    assert.equal(existsSync(path.join(manager.options.dataDir, "identity.json")), false);
    await assert.rejects(manager.register({ controlUrl: "/api/control", accessToken: "t", name: " ", mode: "normal" }), /name/);
    await manager.stop();
  });

  it("creates pairing links with a locally rendered QR code", async () => {
    const manager = makeManager("pair");
    await assert.rejects(manager.pair(), /not running/);
    manager.start();
    await waitFor(() => existsSync(adminSocketPath(manager.options.dataDir)));
    const paired = await manager.pair({ label: "Phone" });
    assert.equal(paired.uri, "aa-pair://v1/test-Phone");
    assert.match(paired.qr_svg, /^<svg/);
    assert.deepEqual(await adminCall(manager.options.dataDir, { cmd: "pair" }), { uri: "aa-pair://v1/test-", expires_at: "2030-01-01T00:00:00Z", pairing_id: "p1" });
    await manager.stop();
  });
});
