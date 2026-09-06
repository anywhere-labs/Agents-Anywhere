import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyDesktopApi } from "./api-proxy";

const trusted = ["aa-workbench://web", "http://127.0.0.1:5184"];

test("development preflight is answered locally and never forwarded to a backend", async () => {
  const response = await proxyDesktopApi(new Request("aa-workbench://web/api/v2/auth/me", {
    method: "OPTIONS",
    headers: { origin: trusted[1], "access-control-request-headers": "authorization" },
  }), "https://self.example", trusted, async () => { throw new Error("must not fetch"); });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), trusted[1]);
  assert.equal(response.headers.get("access-control-allow-headers"), "authorization");
});

test("untrusted web origins cannot call the Desktop API proxy", async () => {
  const response = await proxyDesktopApi(new Request("aa-workbench://web/api/v2/auth/me", {
    headers: { origin: "https://untrusted.example" },
  }), "https://self.example", trusted, async () => { throw new Error("must not fetch"); });
  assert.equal(response.status, 403);
});

test("POST bodies remain valid streaming Fetch requests", async () => {
  const response = await proxyDesktopApi(new Request("aa-workbench://web/api/v2/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  }), "https://self.example", trusted, async (url, init) => {
    const forwarded = new Request(String(url), init);
    assert.deepEqual(await forwarded.json(), { message: "hello" });
    return Response.json({ ok: true });
  });
  assert.equal(response.status, 200);
});

test("the proxy preserves authentication, query parameters, and streamed responses on the selected server", async () => {
  const response = await proxyDesktopApi(new Request("aa-workbench://web/api/v2/files?cursor=2", {
    headers: { origin: trusted[1], authorization: "Bearer test-token" },
  }), "https://self.example", trusted, async (url, init) => {
    assert.equal(url, "https://self.example/api/v2/files?cursor=2");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.equal(new Headers(init?.headers).has("origin"), false);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed file"));
      controller.close();
    } }), { headers: { "content-type": "text/plain" } });
  });
  assert.equal(response.headers.get("access-control-allow-origin"), trusted[1]);
  assert.equal(await response.text(), "streamed file");
});
