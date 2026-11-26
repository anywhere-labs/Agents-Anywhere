import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { controlProxyTarget, mapDynamicSegments, proxyRequest, resolveStaticFile, serveStatic } from "../src/main/app-protocol";
import { deepLinkFromArgv, deepLinkRoute } from "../src/main/deep-link";
import { IPC } from "../src/shared/bridge";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aa-dv3-proto-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function touch(rel: string, body = rel): void {
  const full = path.join(tmp, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

for (const rel of [
  "index.html",
  "404.html",
  "settings.html",
  "devices/_.html",
  "devices/_.txt",
  "devices/_/__next._tree.txt",
  "sessions/_/_.html",
  "sessions/_/_.txt",
  "sessions/_/_/__next.sessions.$d$deviceId.$d$sessionId.__PAGE__.txt",
  "_next/static/chunks/app.js",
]) {
  touch(rel);
}

describe("static export mapping", () => {
  it("maps concrete ids of dynamic routes to the placeholder", () => {
    assert.deepEqual(mapDynamicSegments("/devices/dev_1"), ["devices", "_"]);
    assert.deepEqual(mapDynamicSegments("/devices/dev_1.txt"), ["devices", "_.txt"]);
    assert.deepEqual(mapDynamicSegments("/devices/dev_1/__next._tree.txt"), ["devices", "_", "__next._tree.txt"]);
    assert.deepEqual(mapDynamicSegments("/sessions/dev_1/ses_2"), ["sessions", "_", "_"]);
    assert.deepEqual(mapDynamicSegments("/sessions/dev_1/ses_2.txt"), ["sessions", "_", "_.txt"]);
    assert.deepEqual(mapDynamicSegments("/sessions/dev_1/ses_2/__next._full.txt"), ["sessions", "_", "_", "__next._full.txt"]);
    assert.deepEqual(mapDynamicSegments("/sessions/dev_1"), ["sessions", "dev_1"]);
    assert.deepEqual(mapDynamicSegments("/settings"), ["settings"]);
    assert.deepEqual(mapDynamicSegments("/devices"), ["devices"]);
  });

  it("resolves pages, payloads and assets", () => {
    const rel = (p: string) => {
      const hit = resolveStaticFile(tmp, p);
      return hit && { file: path.relative(tmp, hit.file), status: hit.status };
    };
    assert.deepEqual(rel("/"), { file: "index.html", status: 200 });
    assert.deepEqual(rel("/settings"), { file: "settings.html", status: 200 });
    assert.deepEqual(rel("/devices/dev_abc"), { file: "devices/_.html", status: 200 });
    assert.deepEqual(rel("/devices/dev_abc.txt"), { file: "devices/_.txt", status: 200 });
    assert.deepEqual(rel("/devices/dev_abc/__next._tree.txt"), { file: "devices/_/__next._tree.txt", status: 200 });
    assert.deepEqual(rel("/sessions/dev_abc/ses%20x"), { file: "sessions/_/_.html", status: 200 });
    assert.deepEqual(rel("/sessions/a/b/__next.sessions.$d$deviceId.$d$sessionId.__PAGE__.txt"), {
      file: "sessions/_/_/__next.sessions.$d$deviceId.$d$sessionId.__PAGE__.txt",
      status: 200,
    });
    assert.deepEqual(rel("/_next/static/chunks/app.js"), { file: "_next/static/chunks/app.js", status: 200 });
    assert.deepEqual(rel("/nope"), { file: "404.html", status: 404 });
  });

  it("never escapes the export directory", () => {
    writeFileSync(path.join(path.dirname(tmp), "aa-dv3-secret.txt"), "secret");
    for (const p of ["/../aa-dv3-secret.txt", "/%2e%2e/aa-dv3-secret.txt", "/devices/..%2f..%2faa-dv3-secret.txt"]) {
      const hit = resolveStaticFile(tmp, p);
      assert.ok(hit === null || hit.status === 404 || hit.file.startsWith(tmp), p);
    }
    rmSync(path.join(path.dirname(tmp), "aa-dv3-secret.txt"), { force: true });
  });

  it("serves files with content types", async () => {
    const page = await serveStatic(tmp, "/devices/dev_1");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await page.text(), "devices/_.html");
    const rsc = await serveStatic(tmp, "/devices/dev_1.txt");
    assert.equal(rsc.headers.get("content-type"), "text/x-component");
    const missing = await serveStatic(tmp, "/missing");
    assert.equal(missing.status, 404);
    assert.equal(readFileSync(path.join(tmp, "404.html"), "utf8"), await missing.text());
  });
});

describe("control proxy", () => {
  it("maps /api/control to the configured control URL", () => {
    const target = controlProxyTarget(new URL("app://aa/api/control/auth/login?x=1"), "http://127.0.0.1:8790/");
    assert.equal(target, "http://127.0.0.1:8790/auth/login?x=1");
    assert.equal(controlProxyTarget(new URL("app://aa/settings"), "http://x"), null);
    assert.throws(() => controlProxyTarget(new URL("app://aa/api/control/x"), ""), /control server/);
  });

  it("maps /api/remote to absolute http(s) URLs only", () => {
    const url = new URL(`app://aa/api/remote?url=${encodeURIComponent("https://aa.example.com/auth/config")}`);
    assert.equal(controlProxyTarget(url, ""), "https://aa.example.com/auth/config");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) {
      assert.throws(() => controlProxyTarget(new URL(`app://aa/api/remote?url=${encodeURIComponent(bad)}`), ""), /invalid proxy target/);
    }
  });

  it("forwards method, body and safe headers, and strips encoding headers from the answer", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json", "content-encoding": "gzip", "set-cookie": "a=b", "x-request-id": "r1" },
      });
    };
    const request = new Request("app://aa/api/control/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t", origin: "app://aa", cookie: "c=d" },
      body: JSON.stringify({ email: "a" }),
    });
    const res = await proxyRequest(request, "http://127.0.0.1:8790/auth/login", fetchImpl);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("x-request-id"), "r1");
    assert.deepEqual(await res.json(), { ok: true });
    const headers = new Headers(seen!.init.headers);
    assert.equal(seen!.url, "http://127.0.0.1:8790/auth/login");
    assert.equal(seen!.init.method, "POST");
    assert.equal(headers.get("authorization"), "Bearer t");
    assert.equal(headers.get("origin"), null);
    assert.equal(headers.get("cookie"), null);
    assert.ok(seen!.init.body);
  });

  it("answers 502 when the control server is unreachable, and handles empty answers", async () => {
    const down = await proxyRequest(new Request("app://aa/api/control/x"), "http://127.0.0.1:1/x", async () => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(down.status, 502);
    assert.match(await down.text(), /control_unreachable/);
    const empty = await proxyRequest(new Request("app://aa/api/control/x"), "http://h/x", async () => new Response(null, { status: 204 }));
    assert.equal(empty.status, 204);
  });
});

describe("deep links", () => {
  it("maps allowed routes", () => {
    assert.equal(deepLinkRoute("agents-anywhere://sessions/dev_1/ses_2"), "/sessions/dev_1/ses_2");
    assert.equal(deepLinkRoute("agents-anywhere:///devices/dev_1"), "/devices/dev_1");
    assert.equal(deepLinkRoute("agents-anywhere://auth/oidc/callback?code=c&state=s"), "/auth/oidc/callback?code=c&state=s");
    assert.equal(deepLinkRoute("agents-anywhere://settings"), "/settings");
  });

  it("rejects everything else", () => {
    assert.equal(deepLinkRoute("agents-anywhere://evil/../../etc"), null);
    assert.equal(deepLinkRoute("https://sessions/a/b"), null);
    assert.equal(deepLinkRoute("agents-anywhere://sessions/a"), null);
    assert.equal(deepLinkRoute("not a url"), null);
  });

  it("finds a deep link in argv", () => {
    assert.equal(deepLinkFromArgv(["/app", "--flag", "agents-anywhere://devices/d1"]), "/devices/d1");
    assert.equal(deepLinkFromArgv(["/app"]), null);
  });
});

describe("preload bridge", () => {
  it("uses the same IPC channel names as the main process", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "src", "preload", "preload.ts"), "utf8");
    for (const [key, channel] of Object.entries(IPC)) {
      assert.ok(source.includes(`${key}: "${channel}"`), `${key} → ${channel}`);
    }
  });
});
