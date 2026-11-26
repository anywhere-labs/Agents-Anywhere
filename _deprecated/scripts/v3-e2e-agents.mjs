#!/usr/bin/env node
// End-to-end check of a running local v3 stack (scripts/v3-local-up.sh --with-connector) with real ACP agents.
//
//   node scripts/v3-e2e-agents.mjs [agent ...]     default: every runtime the device reports
//
// Path exercised, exactly like a client: control-plane login → client Router token → watch_devices →
// open_tunnel → aa.v3.Sessions create / send(wait) / watch / list_messages through the tunnel → delete.
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Mesh, Router } = await import(pathToFileURL(path.join(ROOT, "connector-v3/node_modules/meshcall/dist/src/index.js")).href);

const CONTROL = process.env.AA_V3_CONTROL ?? `http://127.0.0.1:${process.env.AA_V3_CONTROL_PORT ?? 8790}`;
const EMAIL = process.env.AA_V3_ADMIN_EMAIL ?? "dev@aa.local";
const PASSWORD = process.env.AA_V3_ADMIN_PASSWORD ?? "aa-dev-password";
const TURN_TIMEOUT_MS = Number(process.env.AA_V3_TURN_TIMEOUT_MS ?? 240_000);

async function http(pathname, body, token) {
  const res = await fetch(CONTROL + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} ${text}`);
  return JSON.parse(text);
}

const login = await http("/auth/login", { email: EMAIL, password: PASSWORD });
const routerToken = await http("/auth/router-token", { client_id: "e2e-script", platform: "web" }, login.access_token);
const { router_url, token } = routerToken.tokens[0];
const control = await Mesh.connect(new Router(router_url), { token });

const devices = control.serverStream("aa.v3.Control", "watch_devices", {});
const first = await devices.next();
const snapshot = first.value;
const list = snapshot.devices ?? snapshot.items ?? [];
const device = list.find((d) => (d.presence ?? d.status) === "online") ?? list[0];
if (!device) throw new Error(`no device: ${JSON.stringify(snapshot)}`);
console.log(`device ${device.id ?? device.device_id} "${device.name}" ${device.presence ?? device.status} mode=${device.mode ?? device.mode_hint}`);
const deviceId = device.id ?? device.device_id;
devices.cancel?.();

const opened = await control.unary("aa.v3.Control", "open_tunnel", { device_id: deviceId, client_id: "e2e-script" });
const tunnel = await Mesh.connect(new Router(opened.router_url), { tunnel: opened.credential });
const call = (svc, method, req) => tunnel.unary(svc, method, req, { instance: deviceId, timeoutMs: TURN_TIMEOUT_MS + 10_000 });

const status = await call("aa.v3.Device", "status", {});
const runtimes = (status.runtimes ?? []).map((r) => r.id ?? r);
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : runtimes;
console.log(`runtimes on device: ${runtimes.join(", ")}; testing: ${wanted.join(", ")}`);

const results = [];
for (const agent of wanted) {
  const started = Date.now();
  let sessionId;
  try {
    const session = await call("aa.v3.Sessions", "create", { agent, cwd: os.tmpdir(), title: `e2e ${agent}` });
    sessionId = session.id;
    const config = (session.config ?? []).map((c) => `${c.id}=${c.current}`).join(" ");
    const word = `PONG-${agent.toUpperCase()}`;
    const sent = await call("aa.v3.Sessions", "send", {
      session_id: sessionId,
      text: `Reply with exactly the single word ${word} and nothing else. Do not use any tools.`,
      wait: true,
    });
    const reply = (sent.reply_text ?? "").trim();
    const page = await call("aa.v3.Sessions", "list_messages", { session_id: sessionId, limit: 20 });
    const ok = reply.includes(word);
    if (process.env.AA_V3_DEBUG) for (const m of page.messages) console.log("  ", m.role, m.done, JSON.stringify(m.parts).slice(0, 300));
    results.push({ agent, ok, ms: Date.now() - started, reply: reply.slice(0, 120), messages: page.messages.length, config, ...(sent.error ? { error: `turn ${sent.turn_result}: ${sent.error}` } : {}) });
  } catch (error) {
    results.push({ agent, ok: false, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 400) });
  } finally {
    if (sessionId && !process.env.AA_V3_KEEP_SESSIONS) await call("aa.v3.Sessions", "delete", { id: sessionId }).catch(() => undefined);
  }
  const r = results.at(-1);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${agent} (${(r.ms / 1000).toFixed(1)} s) ${r.error ?? `reply=${JSON.stringify(r.reply)} messages=${r.messages} ${r.config}`}`);
}

await tunnel.close();
await control.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
