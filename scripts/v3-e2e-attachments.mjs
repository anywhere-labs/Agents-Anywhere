#!/usr/bin/env node
// Attachments end to end on a running local v3 stack (scripts/v3-local-up.sh --with-connector, drive enabled):
//
//   node scripts/v3-e2e-attachments.mjs [agent]      default agent: codex
//
// 1. small file  → aa.v3.Device/save_attachment(session_id)            (RPC path)
// 2. large file  → server-v3 drive upload (presigned PUT) → aa.v3.Device/fetch_drive_file(session_id)
// 3. both land in <cwd>/.agents-anywhere/attachments/<session>/ with a `*` .gitignore
// 4. a message with both attachments; the agent must quote secrets that are only inside the files
// 5. deleting the conversation removes its attachment folder
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Mesh, Router } = await import(pathToFileURL(path.join(ROOT, "connector-v3/node_modules/meshcall/dist/src/index.js")).href);
const CONTROL = process.env.AA_V3_CONTROL ?? "http://127.0.0.1:8790";
const agent = process.argv[2] ?? "codex";

async function http(method, pathname, body, token) {
  const res = await fetch(CONTROL + pathname, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
const step = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const login = await http("POST", "/auth/login", { email: process.env.AA_V3_ADMIN_EMAIL ?? "dev@aa.local", password: process.env.AA_V3_ADMIN_PASSWORD ?? "aa-dev-password" });
const token = login.access_token;
const rt = await http("POST", "/auth/router-token", { client_id: "e2e-attach", platform: "web" }, token);
const control = await Mesh.connect(new Router(rt.tokens[0].router_url), { token: rt.tokens[0].token });
const devices = control.serverStream("aa.v3.Control", "watch_devices", {});
const snap = (await devices.next()).value;
const device = (snap.devices ?? []).find((d) => d.presence === "online");
const deviceId = device.id;
const opened = await control.unary("aa.v3.Control", "open_tunnel", { device_id: deviceId, client_id: "e2e-attach" });
const tunnel = await Mesh.connect(new Router(opened.router_url), { tunnel: opened.credential });
const call = (svc, m, req, timeoutMs = 240_000) => tunnel.unary(svc, m, req, { instance: deviceId, timeoutMs });

const project = await fs.mkdtemp(path.join(os.tmpdir(), "aa-attach-project-"));
const session = await call("aa.v3.Sessions", "create", { agent, cwd: project, title: "e2e attachments" });

// 1. small, through RPC
const smallSecret = `small-${randomBytes(4).toString("hex")}`;
const small = await call("aa.v3.Device", "save_attachment", {
  session_id: session.id,
  name: "notes.txt",
  mime: "text/plain",
  base64: Buffer.from(`The small secret is ${smallSecret}.\n`).toString("base64"),
});
step(small.path.startsWith(path.join(project, ".agents-anywhere", "attachments", session.id)), "small attachment saved in the project", small.path);

// 2. large, through the drive (9 MiB > the 8 MiB RPC cap)
const largeSecret = `large-${randomBytes(4).toString("hex")}`;
const large = Buffer.concat([Buffer.from(`The large secret is ${largeSecret}.\n`), Buffer.alloc(9 * 1024 * 1024, "x\n")]);
const sha256 = createHash("sha256").update(large).digest("hex");
const created = await http("POST", "/drive/uploads", { purpose: "transfer", size_bytes: large.byteLength, sha256, filename: "big-log.txt", mime_type: "text/plain" }, token);
const put = await fetch(created.upload.url, { method: created.upload.method, headers: created.upload.headers, body: large });
step(put.ok, "presigned upload to the drive", `HTTP ${put.status}`);
await http("POST", `/drive/files/${created.file.id}/complete`, {}, token);
const fetched = await call("aa.v3.Device", "fetch_drive_file", { file_id: created.file.id, session_id: session.id, sha256 });
const onDisk = await fs.readFile(fetched.path);
step(onDisk.equals(large), "device fetched the drive file intact", `${fetched.path} (${onDisk.byteLength} bytes)`);

// 3. .gitignore
const gitignore = await fs.readFile(path.join(project, ".agents-anywhere", ".gitignore"), "utf8").catch(() => "");
step(gitignore.trim().endsWith("*"), "project .agents-anywhere/.gitignore ignores everything");

// 4. the agent reads both
const sent = await call("aa.v3.Sessions", "send", {
  session_id: session.id,
  text: "Read the two attached files and reply with exactly the two secret values they contain, separated by a space. Nothing else.",
  attachments: [small, fetched].map(({ path: p, name, mime, size }) => ({ path: p, name, mime, size })),
  wait: true,
});
let reply = sent.reply_text ?? "";
if (sent.turn_result === undefined) {
  // send(wait) gives up after ~28 s; follow the conversation until the turn really ends.
  const watch = tunnel.serverStream("aa.v3.Sessions", "watch", { id: session.id }, { instance: deviceId });
  const deadline = Date.now() + 300_000;
  let messages = [];
  for await (const event of watch) {
    if (event.type === "snapshot") messages = event.messages;
    if (event.type === "message") messages = [...messages.filter((m) => m.id !== event.message.id), event.message];
    const state = event.control?.state;
    if ((state && state !== "running") || Date.now() > deadline) break;
  }
  watch.cancel?.();
  const page = await call("aa.v3.Sessions", "list_messages", { session_id: session.id, limit: 50 });
  reply = page.messages.filter((m) => m.role === "assistant" && m.turn_id === sent.message_id).flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text).join("");
}
step(reply.includes(smallSecret) && reply.includes(largeSecret), `${agent} read both attachments`, sent.error ? `turn ${sent.turn_result}: ${sent.error}` : JSON.stringify(reply.slice(0, 200)));

if (!(reply.includes(smallSecret) && reply.includes(largeSecret)) || process.env.AA_V3_DEBUG) {
  const page = await call("aa.v3.Sessions", "list_messages", { session_id: session.id, limit: 50 });
  for (const m of page.messages) console.log("  ", m.role, m.turn_id === sent.message_id ? "(turn)" : "", JSON.stringify(m.parts).slice(0, 300));
  console.log("   send →", JSON.stringify(sent).slice(0, 300));
}

// 5. cleanup with the conversation
await call("aa.v3.Sessions", "delete", { id: session.id });
const gone = await fs.stat(path.join(project, ".agents-anywhere", "attachments", session.id)).then(() => false, () => true);
step(gone, "attachments removed with the conversation");

await fs.rm(project, { recursive: true, force: true });
await tunnel.close();
await control.close();
