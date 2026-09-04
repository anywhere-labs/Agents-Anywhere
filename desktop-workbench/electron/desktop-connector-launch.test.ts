import assert from "node:assert/strict";
import test from "node:test";
import { startDesktopConnectorOnLaunch } from "./desktop-connector-launch";

test("a forced update skips both Connector state inspection and startup", async () => {
  let stateCalls = 0;
  let startCalls = 0;
  const started = await startDesktopConnectorOnLaunch({
    updateForced: true,
    enabled: true,
    getState: async () => {
      stateCalls += 1;
      return { hasCredential: true, manualDisconnected: false };
    },
    start: async () => {
      startCalls += 1;
    },
    onStartError: () => undefined,
  });

  assert.equal(started, false);
  assert.equal(stateCalls, 0);
  assert.equal(startCalls, 0);
});

test("an eligible Connector starts after the update gate passes", async () => {
  let startCalls = 0;
  const started = await startDesktopConnectorOnLaunch({
    updateForced: false,
    enabled: true,
    getState: async () => ({ hasCredential: true, manualDisconnected: false }),
    start: async () => {
      startCalls += 1;
    },
    onStartError: () => undefined,
  });

  assert.equal(started, true);
  assert.equal(startCalls, 1);
});

test("a disconnected or unconfigured Connector is not started", async () => {
  let startCalls = 0;
  const started = await startDesktopConnectorOnLaunch({
    updateForced: false,
    enabled: true,
    getState: async () => ({ hasCredential: true, manualDisconnected: true }),
    start: async () => {
      startCalls += 1;
    },
    onStartError: () => undefined,
  });

  assert.equal(started, false);
  assert.equal(startCalls, 0);
});
