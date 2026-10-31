import assert from "node:assert/strict";
import test from "node:test";
import { nextSilentLaunchState, ownershipNeedsWindow, shouldLaunchSilently } from "./silent-launch";

test("silent launch keeps the window hidden while ownership is unresolved", () => {
  // A cold boot spends minutes here: the Connector is still starting, and the
  // old fixed 10 s wait showed the window at the end of it.
  for (const status of ["checking", "preparing"] as const) {
    assert.equal(nextSilentLaunchState("holding", status), "holding");
  }
});

test("silent launch stays hidden for good once this machine owns the Connector", () => {
  assert.equal(nextSilentLaunchState("holding", "owned"), "settled");
  // A later loss of ownership must not pop the window open on its own.
  for (const status of ["checking", "preparing", "conflict", "error"] as const) {
    assert.equal(nextSilentLaunchState("settled", status), "settled");
  }
});

test("silent launch reveals the window only for states the user has to resolve", () => {
  assert.equal(nextSilentLaunchState("holding", "conflict"), "revealed");
  assert.equal(nextSilentLaunchState("holding", "error"), "revealed");
  assert.equal(nextSilentLaunchState("revealed", "owned"), "revealed");
  assert.equal(nextSilentLaunchState("revealed", "conflict"), "revealed");
});

test("ownership window decisions match the states that block the machine", () => {
  assert.equal(ownershipNeedsWindow("conflict"), true);
  assert.equal(ownershipNeedsWindow("error"), true);
  assert.equal(ownershipNeedsWindow("owned"), false);
  assert.equal(ownershipNeedsWindow("checking"), false);
  assert.equal(ownershipNeedsWindow("preparing"), false);
});

test("a login-item launch stays silent even before the Connector reports settings", () => {
  // The settings file says yes, so the decision must not depend on the Connector
  // having answered yet: on a cold boot it answers minutes later.
  const decision = { silentLaunch: true, openedAsLoginItem: true, webUrlOverride: undefined };
  assert.equal(shouldLaunchSilently(decision), true);
});

test("a manual launch still asks for a window", () => {
  const decision = { silentLaunch: true, openedAsLoginItem: false, webUrlOverride: undefined };
  assert.equal(shouldLaunchSilently(decision), false);
});

test("silent launch is skipped when the user turned it off or a web build is forced", () => {
  const base = { openedAsLoginItem: true, webUrlOverride: undefined };
  assert.equal(shouldLaunchSilently({ ...base, silentLaunch: false }), false);
  assert.equal(shouldLaunchSilently({ ...base, silentLaunch: undefined }), false);
  assert.equal(
    shouldLaunchSilently({ ...base, silentLaunch: true, webUrlOverride: "http://127.0.0.1:5184" }),
    false,
  );
});
