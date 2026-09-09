import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopOnboardingFromArgv, desktopOnboardingFromUrl, desktopOnboardingRoute } from "./desktop-onboarding";
import { isDesktopOAuthCallback } from "./desktop-oauth";

const FLOW_ID = "abcdefghijklmnopqrstuvwx";

test("plugin entries carry only a validated flow id", () => {
  const entry = desktopOnboardingFromUrl(`agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=${FLOW_ID}`);
  assert.deepEqual(entry, {
    source: "dsh-plugin",
    flowId: FLOW_ID,
    route: `/#/onboarding?source=dsh-plugin&flowId=${FLOW_ID}`,
    key: `dsh-plugin:${FLOW_ID}`,
  });
  assert.equal(desktopOnboardingFromUrl("agents-anywhere-desktop://onboarding?source=dsh-plugin")?.route, "/#/onboarding?source=dsh-plugin");
  assert.equal(desktopOnboardingFromUrl(`agents-anywhere-desktop://onboarding?flowId=${FLOW_ID}`)?.source, "dsh-plugin");
});

test("malformed or foreign URLs never start a flow", () => {
  for (const value of [
    "agents-anywhere-desktop://oauth/callback?code=x&state=y",
    "agents-anywhere-desktop://onboarding?flowId=short",
    "agents-anywhere-desktop://onboarding?flowId=../../etc/passwd",
    "agents-anywhere-desktop://onboarding?flowId=" + "a".repeat(101),
    "https://example.test/onboarding",
    "aa-workbench://web/#/onboarding",
    "not a url",
  ]) {
    assert.equal(desktopOnboardingFromUrl(value), null, value);
  }
  assert.equal(desktopOnboardingFromArgv(["electron", ".", "--hidden"]), null);
  assert.equal(desktopOnboardingFromArgv(["electron", ".", `agents-anywhere-desktop://onboarding?flowId=${FLOW_ID}`])?.flowId, FLOW_ID);
});

test("the OAuth queue only accepts OAuth callbacks", () => {
  assert.equal(isDesktopOAuthCallback("agents-anywhere-desktop://oauth/callback?code=x&state=y"), true);
  assert.equal(isDesktopOAuthCallback(`agents-anywhere-desktop://onboarding?flowId=${FLOW_ID}`), false);
  assert.equal(isDesktopOAuthCallback("not a url"), false);
});

test("a user launch builds the same route without a flow id", () => {
  assert.equal(desktopOnboardingRoute({ source: "desktop" }), "/#/onboarding?source=desktop");
  assert.equal(desktopOnboardingRoute({ source: "desktop", flowId: null }), "/#/onboarding?source=desktop");
});
