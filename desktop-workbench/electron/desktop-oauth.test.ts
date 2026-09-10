import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { resolveDesktopServer } from "./desktop-server";
import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_REDIRECT_URI,
  createDesktopOAuthRequest,
  desktopOAuthCodeFromCallback,
  desktopOAuthUrlFromArgv,
  exchangeDesktopOAuthCode,
} from "./desktop-oauth";

test("creates a first-party Desktop authorization request with PKCE", () => {
  const { authorizeUrl, pending } = createDesktopOAuthRequest("https://web.example.com/path", 1000);
  const url = new URL(authorizeUrl);
  const params = new URLSearchParams(url.hash.split("?")[1]);

  assert.equal(url.origin, "https://web.example.com");
  assert.equal(url.hash.split("?")[0], "#/desktop-oauth");
  assert.equal(params.get("client_id"), DESKTOP_OAUTH_CLIENT_ID);
  assert.equal(params.get("redirect_uri"), DESKTOP_OAUTH_REDIRECT_URI);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("state"), pending.state);
  assert.equal(params.get("code_challenge"), createHash("sha256").update(pending.verifier, "ascii").digest("base64url"));
  assert.ok(pending.verifier.length >= 43);
});

test("exchanges the authorization code on its own backend with the original PKCE verifier", async () => {
  const server = resolveDesktopServer("https://self.example");
  const token = await exchangeDesktopOAuthCode("code-from-self-host", "original-verifier", server, async (url, init) => {
    assert.equal(url, "https://self.example/api/v2/oauth/token");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("code"), "code-from-self-host");
    assert.equal(body.get("code_verifier"), "original-verifier");
    assert.equal(body.get("client_id"), DESKTOP_OAUTH_CLIENT_ID);
    assert.equal(body.get("redirect_uri"), DESKTOP_OAUTH_REDIRECT_URI);
    return Response.json({ access_token: "desktop-token" });
  });
  assert.equal(token, "desktop-token");
  await assert.rejects(exchangeDesktopOAuthCode("code", "verifier", server, async () => Response.json({})), /invalid/);
  await assert.rejects(exchangeDesktopOAuthCode("code", "verifier", server, async () => Response.json({ detail: "expired code" }, { status: 400 })), /expired code/);
});

test("accepts only a matching, unexpired Desktop callback", () => {
  const pending = { state: "expected-state", verifier: "verifier", createdAt: 1000 };
  const callback = `${DESKTOP_OAUTH_REDIRECT_URI}?code=oauth-code&state=expected-state`;

  assert.equal(desktopOAuthCodeFromCallback(callback, pending, 2000), "oauth-code");
  assert.throws(
    () => desktopOAuthCodeFromCallback(`${DESKTOP_OAUTH_REDIRECT_URI}?code=x&state=wrong`, pending, 2000),
    /state did not match/,
  );
  assert.throws(() => desktopOAuthCodeFromCallback(callback, pending, 700_001), /expired/);
});

test("extracts Desktop callbacks from secondary-instance arguments", () => {
  const callback = `${DESKTOP_OAUTH_REDIRECT_URI}?code=x&state=y`;
  assert.equal(desktopOAuthUrlFromArgv(["electron", ".", callback]), callback);
  assert.equal(desktopOAuthUrlFromArgv(["electron", "."]), null);
});
