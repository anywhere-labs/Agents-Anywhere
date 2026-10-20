import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DesktopBackendClient } from "./backend-client";
import type { BackendInit } from "./backend/protocol";

const FIXTURE = `
const send = (message) => process.send?.(message);
send({ type: "ready", port: 1, token: "fixture-token" });
send({
  type: "netFetch", id: 7, url: "https://server.example/api/v2/connectors",
  method: "POST", headers: { authorization: "Bearer user" }, body: "{\\"name\\":\\"Office Mac\\"}",
});
process.on("message", (message) => {
  if (message?.type === "netFetchResult") {
    console.log(JSON.stringify({ status: message.status, body: message.body }));
    process.exit(0);
  }
  if (message?.type === "netFetchError") {
    console.log(JSON.stringify({ error: message.message }));
    process.exit(0);
  }
});
`;

function initFor(root: string): BackendInit {
  return {
    dataPath: root,
    logsPath: path.join(root, "logs"),
    settingsPath: path.join(root, "desktop-settings.json"),
    bindingPath: path.join(root, "desktop-binding.json"),
    configPath: path.join(root, "connector.json"),
    connectorDir: root,
    resourcesPath: root,
    uvBundleDir: path.join(root, "build", "uv"),
    pythonBundleDir: path.join(root, "build", "python"),
    homePath: root,
    documentsPath: root,
    packaged: false,
    preferredLanguages: ["zh-CN"],
    defaultServerUrl: "https://server.example",
    apiNamespace: "/api/v2",
    desktopExecutablePath: path.join(root, "Electron"),
    desktopAppPath: root,
  };
}

async function waitFor(check: () => boolean, failure: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(failure);
}

test("proxies a backend netFetch request that arrives after the ready handshake", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, FIXTURE, "utf8");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async (url, requestInit) => {
      if (url.endsWith("/events")) return new Response("", { status: 200 });
      calls.push({ url, init: requestInit });
      return new Response("{\"connectorToken\":\"fixture\"}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    await client.start(initFor(root));
    await waitFor(() => calls.length > 0, "The backend never proxied its netFetch request.");
    assert.equal(calls[0].url, "https://server.example/api/v2/connectors");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(calls[0].init?.headers, { authorization: "Bearer user" });
    assert.equal(calls[0].init?.body, "{\"name\":\"Office Mac\"}");
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a backend that stops after ready reports its last error and output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-crash-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, `
process.send({ type: "ready", port: 1, token: "fixture-token" });
setTimeout(() => process.stderr.write("TypeError: boom\\n    at initialize (state.js:1:1)\\n", () => {
  process.send({ type: "error", message: "Desktop backend crashed: boom" }, () => process.exit(1));
}), 50);
`, "utf8");
  const exits: string[] = [];
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async () => new Response("", { status: 200 }),
    onExit: (message) => exits.push(message),
  });
  try {
    await client.start(initFor(root));
    assert.equal(client.running, true);
    await waitFor(() => exits.length > 0, "The backend exit was never reported.");
    assert.equal(client.running, false, "Main writes the log itself once the backend is gone");
    assert.equal(exits[0], [
      "Desktop backend stopped unexpectedly (code 1).",
      "Desktop backend crashed: boom",
      "Last output:",
      "TypeError: boom",
      "at initialize (state.js:1:1)",
    ].join("\n"));
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a backend that exits before ready rejects startup with its exit code and output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-early-exit-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, `process.stderr.write("Error: Cannot find module 'missing'\\n", () => process.exit(3));`, "utf8");
  const exits: string[] = [];
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async () => new Response("", { status: 200 }),
    onExit: (message) => exits.push(message),
  });
  try {
    await assert.rejects(client.start(initFor(root)), {
      message: "Desktop backend exited before it became ready (code 3).\nLast output:\nError: Cannot find module 'missing'",
    });
    await delay(50);
    assert.deepEqual(exits, [], "startup reports the exit once, through the rejected start");
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown tolerates a backend that already closed its IPC channel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-shutdown-race-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, `
process.send({ type: "ready", port: 1, token: "fixture-token" });
process.disconnect();
setTimeout(() => process.exit(0), 200);
`, "utf8");
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async () => new Response("", { status: 200 }),
  });
  try {
    await client.start(initFor(root));
    await client.shutdown();
    assert.equal(client.running, false, "shutdown waits for the disconnected backend to exit");
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closed-channel errors preserve the backend's actual failure reason", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-error-reason-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, `
process.send({ type: "ready", port: 1, token: "fixture-token" });
setInterval(() => {}, 1_000);
`, "utf8");
  const fork = childProcess.fork;
  let child: childProcess.ChildProcess | undefined;
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof fork>) => {
    child = fork(...args);
    return child;
  });
  const logged: string[] = [];
  t.mock.method(console, "error", (message: string) => logged.push(message));
  const exits: string[] = [];
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async () => new Response("", { status: 200 }),
    onExit: (message) => exits.push(message),
  });
  try {
    await client.start(initFor(root));
    assert.ok(child);
    child.emit("error", Object.assign(new Error("backend initialization failed"), { code: "ENOENT" }));
    for (const code of ["ERR_IPC_CHANNEL_CLOSED", "EPIPE"]) {
      child.emit("error", Object.assign(new Error(code), { code }));
    }
    child.kill();
    await waitFor(() => exits.length > 0, "The backend exit was never reported.");
    assert.match(exits[0], /Desktop backend process error: backend initialization failed/);
    assert.doesNotMatch(exits[0], /ERR_IPC_CHANNEL_CLOSED|EPIPE/);
    assert.deepEqual(logged, ["[desktop-backend] backend initialization failed"]);
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a netFetch reply is dropped when the backend closes its channel mid-request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-fetch-race-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, `
process.send({ type: "ready", port: 1, token: "fixture-token" });
process.send({
  type: "netFetch", id: 9, url: "https://server.example/api/v2/connectors",
  method: "GET", headers: {},
});
process.disconnect();
setTimeout(() => process.exit(0), 500);
`, "utf8");
  let fetchStarted = false;
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async (url) => {
      if (url.endsWith("/events")) return new Response("", { status: 200 });
      fetchStarted = true;
      // The backend disconnects while this request is in flight, so the reply
      // below targets a closed IPC channel.
      await delay(100);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await client.start(initFor(root));
    await waitFor(() => fetchStarted, "The backend never proxied its netFetch request.");
    await delay(250);
    await client.shutdown();
    assert.equal(client.running, false, "shutdown survives the dropped reply");
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
