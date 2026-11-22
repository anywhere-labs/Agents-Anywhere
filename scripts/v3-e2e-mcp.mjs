#!/usr/bin/env node
// MCP end to end on a running local v3 stack: an external agent controlling a normal device through server-v3's /mcp.
//
//   node scripts/v3-e2e-mcp.mjs [agent]       default agent: pi
//
// OAuth 2.1 (dynamic registration + PKCE, approved as the local admin) → Streamable HTTP MCP: initialize,
// tools/list, list_devices, list_sessions, create_session, send_message(wait), read_session, stop_session.
// Also checks that the device's "allow external agents" switch is enforced.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.AA_V3_STATE_DIR ?? path.join(ROOT, ".local-dev", "v3");
const CONTROL = process.env.AA_V3_CONTROL ?? "http://127.0.0.1:8790";
const agent = process.argv[2] ?? "pi";
const step = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};
async function http(method, pathname, body, token, form) {
  const res = await fetch(CONTROL + pathname, {
    method,
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname}: HTTP ${res.status} ${text}`);
  return JSON.parse(text);
}
const connector = (...args) =>
  execFileSync(process.execPath, [path.join(ROOT, "connector-v3/dist/src/cli.js"), ...args], {
    env: { ...process.env, AA_CONNECTOR_DATA_DIR: path.join(STATE, "connector") },
    encoding: "utf8",
  });

const login = await http("POST", "/auth/login", { email: process.env.AA_V3_ADMIN_EMAIL ?? "dev@aa.local", password: process.env.AA_V3_ADMIN_PASSWORD ?? "aa-dev-password" });
const deviceId = JSON.parse((await import("node:fs")).readFileSync(path.join(STATE, "connector", "identity.json"), "utf8")).device_id;

// OAuth 2.1: dynamic client registration, PKCE, user approval, code exchange.
const redirect = "http://127.0.0.1:9/callback";
const reg = await http("POST", "/oauth/register", { client_name: "e2e MCP client", redirect_uris: [redirect] });
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const scopes = ["devices:read", "sessions:read", "sessions:write"];
const preview = await http("GET", `/oauth/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scopes.join(" "))}`, undefined, login.access_token);
step(Boolean(preview), "consent preview", JSON.stringify(preview).slice(0, 160));
const approved = await http("POST", "/oauth/authorize", { client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scopes, device_ids: [deviceId] }, login.access_token);
const tok = await http("POST", "/oauth/token", undefined, undefined, { grant_type: "authorization_code", client_id: reg.client_id, code: approved.code, redirect_uri: redirect, code_verifier: verifier });
step(typeof tok.access_token === "string", "MCP access token issued", `scope=${tok.scope ?? ""}`);

let sessionHeader;
let rpcId = 0;
async function mcp(method, params) {
  const res = await fetch(`${CONTROL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tok.access_token}`,
      ...(sessionHeader ? { "mcp-session-id": sessionHeader } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  sessionHeader = res.headers.get("mcp-session-id") ?? sessionHeader;
  const text = await res.text();
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).at(-1));
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
const tool = async (name, args) => {
  const r = await mcp("tools/call", { name, arguments: args });
  const textOut = (r.content ?? []).map((c) => c.text ?? "").join("");
  let data = r.structuredContent;
  if (data === undefined) {
    try {
      data = JSON.parse(textOut);
    } catch {
      data = textOut;
    }
  }
  return { isError: r.isError === true, data, text: textOut };
};

const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aa-e2e", version: "1" } });
step(Boolean(init.serverInfo), "initialize", `${init.serverInfo?.name} ${init.protocolVersion}`);
const tools = (await mcp("tools/list", {})).tools.map((t) => t.name);
step(tools.includes("send_message") && !tools.includes("nonexistent"), "tools/list", tools.join(","));

connector("mcp", "off");
const denied = await tool("list_sessions", {});
step(denied.isError || /permission_denied|mcp_disabled/.test(denied.text), "device with MCP switched off is not controllable", denied.text.slice(0, 120));
connector("mcp", "on");

const devices = await tool("list_devices", {});
step(devices.text.includes(deviceId), "list_devices", devices.text.slice(0, 120));
const created = await tool("create_session", { device_id: deviceId, agent, cwd: os.tmpdir(), title: "e2e MCP" });
const sessionId = created.data?.id ?? created.data?.session?.id ?? created.data?.session_id;
step(Boolean(sessionId) && !created.isError, "create_session", created.text.slice(0, 120));
const sent = await tool("send_message", { device_id: deviceId, session_id: sessionId, text: "Reply with exactly the word VIA-MCP and nothing else. Do not use tools.", wait: true });
step(sent.text.includes("VIA-MCP"), "send_message(wait) returns the reply", sent.text.slice(0, 160));
const read = await tool("read_session", { device_id: deviceId, session_id: sessionId });
step(read.text.includes("VIA-MCP") && /mcp/i.test(read.text), "read_session shows the turn and its MCP author", read.text.slice(0, 160));
const listed = await tool("list_sessions", {});
step(listed.text.includes(sessionId), "list_sessions (control-plane fan-out)");
const stopped = await tool("stop_session", { device_id: deviceId, session_id: sessionId });
step(!stopped.isError, "stop_session");
