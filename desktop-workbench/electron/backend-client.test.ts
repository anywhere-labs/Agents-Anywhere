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

// The channel closes first and the process lingers: the window in which Main
// still holds `child` but every send to it fails.
const CLOSING_CHANNEL_FIXTURE = (afterReady: string) => `
process.send({ type: "ready", port: 1, token: "fixture-token" }, () => {
  ${afterReady}
});
`;
const DISCONNECT_AND_LINGER = `process.disconnect(); setTimeout(() => process.exit(0), 400);`;

test("a netFetch reply to a backend whose channel already closed does not crash Main", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-fetch-race-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, CLOSING_CHANNEL_FIXTURE(`
  process.send({ type: "netFetch", id: 9, url: "https://server.example/api/v2/connectors", method: "GET", headers: {}, body: null }, () => {
    ${DISCONNECT_AND_LINGER}
  });`), "utf8");
  let fetchStarted = false;
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async (url) => {
      if (url.endsWith("/events")) return new Response("", { status: 200 });
      fetchStarted = true;
      // Answer only after the backend has closed its channel.
      await delay(100);
      return new Response("{}", { status: 200 });
    },
  });
  try {
    await client.start(initFor(root));
    await waitFor(() => fetchStarted, "The backend never proxied its netFetch request.");
    await waitFor(() => !client.running, "The backend never exited.");
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown returns once a backend that closed its channel exits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-shutdown-race-"));
  const entryPath = path.join(root, "fixture-backend.js");
  fs.writeFileSync(entryPath, CLOSING_CHANNEL_FIXTURE(DISCONNECT_AND_LINGER), "utf8");
  const client = new DesktopBackendClient({
    entryPath,
    fetcher: async () => new Response("", { status: 200 }),
  });
  try {
    await client.start(initFor(root));
    await delay(100);
    const started = Date.now();
    await client.shutdown();
    assert.equal(client.running, false);
    assert.ok(Date.now() - started < 2_000, "shutdown saw the exit instead of waiting out its grace period");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a backend that cannot be spawned fails startup at once and still shuts down", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-client-spawn-failure-"));
  const missing = path.join(root, "missing-node");
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (modulePath: string, args: string[], options: childProcess.ForkOptions) =>
    fork(modulePath, args, { ...options, execPath: missing }));
  const logged: string[] = [];
  t.mock.method(console, "error", (message: string) => logged.push(message));
  const client = new DesktopBackendClient({
    entryPath: path.join(root, "fixture-backend.js"),
    fetcher: async () => new Response("", { status: 200 }),
  });
  try {
    const started = Date.now();
    await assert.rejects(client.start(initFor(root)), (error: Error) => {
      assert.match(error.message, /^Desktop backend exited before it became ready \(code -?\d+\)\.\nDesktop backend could not be started: spawn .*ENOENT/);
      return true;
    });
    assert.ok(Date.now() - started < 2_000, "startup does not wait out the ready timeout");
    assert.ok(logged.some((line) => /^\[desktop-backend\] spawn .*ENOENT/.test(line)), "the spawn error is logged");
    // A failed spawn never emits `exit`; shutdown must not wait for one.
    const finished = await Promise.race([client.shutdown().then(() => true), delay(2_000).then(() => false)]);
    assert.equal(finished, true, "shutdown returns after a failed spawn");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
