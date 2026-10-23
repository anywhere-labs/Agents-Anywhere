import assert from "node:assert/strict";
import test from "node:test";
import { nextSilentLaunchState, ownershipNeedsWindow } from "./silent-launch";

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
