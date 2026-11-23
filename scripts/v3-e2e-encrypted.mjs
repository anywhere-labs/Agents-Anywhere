#!/usr/bin/env node
// Encrypted-device end to end on a running local v3 stack (scripts/v3-local-up.sh --with-connector):
//
//   node scripts/v3-e2e-encrypted.mjs [agent]          default agent: pi
//
// Starts (once) a second Connector registered in encrypted mode with its own data dir, then checks:
//   1. first pairing with the out-of-band aa-pair:// link (Noise_IKpsk2) and a real agent turn through it
//   2. reconnecting as the paired client without the pairing secret (Noise_IK)
//   3. the pairing link is single-use
//   4. an unpaired client key is refused at the handshake
//   5. the control plane's aggregated list shows the device only as `encrypted`, never its sessions
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.AA_V3_STATE_DIR ?? path.join(ROOT, ".local-dev", "v3");
const { Mesh, Router, generateE2EKey } = await import(pathToFileURL(path.join(ROOT, "connector-v3/node_modules/meshcall/dist/src/index.js")).href);
const CONTROL = process.env.AA_V3_CONTROL ?? "http://127.0.0.1:8790";
const CLI = path.join(ROOT, "connector-v3/dist/src/cli.js");
const DATA = path.join(STATE, "connector-encrypted");
const agent = process.argv[2] ?? "pi";

const step = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};
async function http(pathname, body, token) {
  const res = await fetch(CONTROL + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} ${text}`);
  return JSON.parse(text);
}
const env = { ...process.env, AA_CONNECTOR_DATA_DIR: DATA };
const alive = (pidFile) => {
  try {
    process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
};

// ── the encrypted device ──
const login = await http("/auth/login", { email: process.env.AA_V3_ADMIN_EMAIL ?? "dev@aa.local", password: process.env.AA_V3_ADMIN_PASSWORD ?? "aa-dev-password" });
if (!fs.existsSync(path.join(DATA, "identity.json"))) {
  execFileSync(process.execPath, [CLI, "register", "--control-url", CONTROL, "--access-token", login.access_token, "--name", "v3 local (encrypted)", "--mode", "encrypted"], { env, stdio: "inherit" });
}
const pidFile = path.join(STATE, "connector-encrypted.pid");
if (!alive(pidFile)) {
  const out = fs.openSync(path.join(STATE, "connector-encrypted.log"), "a");
  const child = spawn(process.execPath, [CLI, "start"], { env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  await new Promise((r) => setTimeout(r, 4000));
}
const identity = JSON.parse(fs.readFileSync(path.join(DATA, "identity.json"), "utf8"));
const deviceId = identity.device_id;

const pairUri = execFileSync(process.execPath, [CLI, "pair", "--label", "e2e script", "--platform", "cli"], { env, encoding: "utf8" })
  .split(/\s+/)
  .find((w) => w.startsWith("aa-pair://v1/"));
const pairing = JSON.parse(Buffer.from(pairUri.slice("aa-pair://v1/".length), "base64url").toString("utf8"));
step(pairing.instance_id === deviceId, "device shows a one-time pairing link (only on this machine)", `pairing ${pairing.pairing_id}`);

// ── client side ──
const rt = await http("/auth/router-token", { client_id: "e2e-encrypted", platform: "desktop" }, login.access_token);
const control = await Mesh.connect(new Router(rt.tokens[0].router_url), { token: rt.tokens[0].token });
const clientKey = await generateE2EKey();

async function connect(keyPair, withPairing) {
  const opened = await control.unary("aa.v3.Control", "open_tunnel", { device_id: deviceId, client_id: "e2e-encrypted", e2e_key: pairing.device_pub });
  if (!opened.credential.startsWith("mtun_e2e.")) throw new Error("control plane returned a non-E2E tunnel for an encrypted device");
  const mesh = new Mesh(new Router(opened.router_url), {
    tunnel: opened.credential,
    e2eKey: pairing.device_pub, // pinned from the QR, never from the server
    e2eIdentity: { privateKey: keyPair.privateKey, instanceId: deviceId, ...(withPairing ? { pairing: { id: pairing.pairing_id, psk: pairing.psk } } : {}) },
  });
  await mesh.connect();
  return mesh;
}

// 1. first pairing + a real turn
let mesh = await connect(clientKey, true);
const status = await mesh.unary("aa.v3.Device", "status", {}, { instance: deviceId });
step(status.mode === "encrypted", "paired over Noise_IKpsk2", `device ${status.device_name}, runtimes ${status.runtimes.map((r) => r.id ?? r).join(",")}`);
const session = await mesh.unary("aa.v3.Sessions", "create", { agent, cwd: os.tmpdir(), title: "e2e encrypted" }, { instance: deviceId, timeoutMs: 300_000 });
const sent = await mesh.unary(
  "aa.v3.Sessions",
  "send",
  { session_id: session.id, text: "Reply with exactly the word SEALED and nothing else. Do not use tools.", wait: true },
  { instance: deviceId, timeoutMs: 300_000 },
);
step((sent.reply_text ?? "").includes("SEALED"), `${agent} answered through the encrypted tunnel`, sent.error ?? JSON.stringify((sent.reply_text ?? "").slice(-60)));
await mesh.close();

// 2. reconnect with Noise_IK (no pairing secret)
mesh = await connect(clientKey, false);
const listed = await mesh.unary("aa.v3.Sessions", "list", {}, { instance: deviceId });
step(listed.sessions.some((s) => s.id === session.id), "reconnected as the paired client (Noise_IK)");
await mesh.unary("aa.v3.Sessions", "delete", { id: session.id }, { instance: deviceId });
await mesh.close();

// 3. pairing link is single-use
const reuse = await connect(await generateE2EKey(), true).then((m) => (m.close(), "connected"), (e) => String(e.message ?? e));
step(reuse !== "connected", "a used pairing link is refused", reuse.slice(0, 80));

// 4. unpaired key
const stranger = await connect(await generateE2EKey(), false).then((m) => (m.close(), "connected"), (e) => String(e.message ?? e));
step(stranger !== "connected", "an unpaired client key is refused", stranger.slice(0, 80));

// 5. control plane sees no content
const agg = control.serverStream("aa.v3.Control", "list_sessions", { device_ids: [deviceId] });
const results = [];
for await (const r of agg) results.push(r);
step(results.length === 1 && results[0].status === "encrypted" && results[0].value == null, "control plane lists the device only as `encrypted`", JSON.stringify(results).slice(0, 120));

await control.close();
