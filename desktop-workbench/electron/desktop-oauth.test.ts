import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_REDIRECT_URI,
  createDesktopOAuthRequest,
  desktopOAuthCodeFromCallback,
  desktopOAuthUrlFromArgv,
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
  assert.ok(params.get("code_challenge"));
  assert.ok(pending.verifier.length >= 43);
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
