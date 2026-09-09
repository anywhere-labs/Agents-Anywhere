import assert from "node:assert/strict";
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

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("The backend never proxied its netFetch request.");
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
    await waitFor(() => calls.length > 0);
    assert.equal(calls[0].url, "https://server.example/api/v2/connectors");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(calls[0].init?.headers, { authorization: "Bearer user" });
    assert.equal(calls[0].init?.body, "{\"name\":\"Office Mac\"}");
  } finally {
    await client.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
