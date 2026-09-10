import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import config from "../config.json";
import { checkDesktopServer, DesktopServerStore, normalizeServerOrigin, resolveDesktopServer } from "./desktop-server";

test("accepts server origins and API base URLs without silently accepting a page or credentials", () => {
  assert.equal(normalizeServerOrigin(" server.example/ "), "https://server.example");
  assert.equal(normalizeServerOrigin("http://192.168.1.2:8000/api/v2/"), "http://192.168.1.2:8000");
  for (const value of ["", "file:///tmp/server", "https://user:secret@server.example", "https://server.example/login", "https://server.example?token=secret", "https://server.example/#/login"]) {
    assert.throws(() => normalizeServerOrigin(value), { code: "invalidServer" });
  }
});

test("Cloud uses central config, while a configured local server can have a separate Web origin", () => {
  const env = {
    WORKBENCH_API_ORIGIN: "http://127.0.0.1:8000",
    WORKBENCH_API_NAMESPACE: "",
    WORKBENCH_OAUTH_WEB_ORIGIN: "http://localhost:5174",
  };
  assert.deepEqual(resolveDesktopServer(undefined, { env, development: true }), {
    ...config.cloud, apiNamespace: config.apiNamespace,
  });
  assert.deepEqual(resolveDesktopServer("http://127.0.0.1:8000", { env, development: true }), {
    serverUrl: "http://127.0.0.1:8000", apiNamespace: "", oauthWebOrigin: "http://localhost:5174",
  });
  assert.equal(resolveDesktopServer("https://self.example", { env }).oauthWebOrigin, "https://self.example");
  assert.equal(resolveDesktopServer("http://127.0.0.1:8000", { development: true }).oauthWebOrigin, "http://127.0.0.1:5174");
});

test("health checks the selected backend without sending credentials", async () => {
  const server = resolveDesktopServer("https://self.example");
  await checkDesktopServer(server, async (url, init) => {
    assert.equal(url, "https://self.example/api/v2/health");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({ status: "ok" });
  });
});

test("HTTP failures, unreachable servers, HTML pages, and unhealthy payloads cannot pass health", async () => {
  const server = resolveDesktopServer("https://self.example");
  for (const [response, code] of [
    [new Response("unavailable", { status: 503 }), "serverUnavailable"],
    [new Response("<html>Login</html>"), "invalidHealth"],
    [Response.json({ status: "error" }), "invalidHealth"],
    [Response.json(null), "invalidHealth"],
  ] as const) {
    await assert.rejects(checkDesktopServer(server, async () => response), { code });
  }
  await assert.rejects(checkDesktopServer(server, async () => { throw new Error("offline"); }), { code: "serverUnavailable" });
});

test("a stalled health request is aborted at the configured deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = checkDesktopServer(resolveDesktopServer("https://self.example"), async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const assertion = assert.rejects(result, { code: "serverTimeout" });
  t.mock.timers.tick(config.healthTimeoutMs);
  await assertion;
});

test("the selected backend survives restart and corrupt stored configuration falls back safely", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "server.json");
  const fallback = resolveDesktopServer();
  const custom = resolveDesktopServer("https://self.example");
  const store = new DesktopServerStore(file, fallback);
  assert.equal(store.getSaved(), null, "defaults are not a saved server");
  store.save(custom);
  assert.deepEqual(store.getSaved(), custom);
  const restarted = new DesktopServerStore(file, fallback);
  assert.deepEqual(restarted.get(), custom);
  assert.deepEqual(restarted.getSaved(), custom);
  fs.writeFileSync(file, JSON.stringify({ serverUrl: "file:///tmp/unsafe", apiNamespace: "/api/v2" }));
  const corrupt = new DesktopServerStore(file, fallback);
  assert.deepEqual(corrupt.get(), fallback);
  assert.equal(corrupt.getSaved(), null);
});
