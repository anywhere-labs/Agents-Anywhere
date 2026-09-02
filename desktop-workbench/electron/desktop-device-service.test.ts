import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopDeviceService } from "./desktop-device-service";
import type { ConnectorSupervisor } from "./connector-supervisor";
import type { ConnectorPrivateConfig } from "./connector-types";

type ConnectorMock = {
  credential: ConnectorPrivateConfig | null;
  running: boolean;
  authFailed: boolean;
  saveCalls: ConnectorPrivateConfig[];
  startCalls: number;
  stopCalls: number;
  restartCalls: number;
  clearCalls: number;
  preflightCalls: number;
};

test("createAndConnect creates a Desktop connector without exposing its token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const harness = createHarness(async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      connector: { id: "connector-1", name: "Office Mac" },
      connectorToken: "connector-secret",
    });
  });

  const result = await harness.service.createAndConnect({
    userId: "user-1",
    userToken: "user-secret",
    name: "Office Mac",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://server.example/api/v2/connectors");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    name: "Office Mac",
    connectorKind: "desktop",
  });
  assert.equal(harness.mock.saveCalls[0].connectorToken, "connector-secret");
  assert.equal(harness.mock.startCalls, 1);
  assert.equal(harness.mock.preflightCalls, 1);
  assert.equal(result.connectorId, "connector-1");
  assert.equal(result.ownerUserId, "user-1");
  assert.equal("connectorToken" in result, false);
  harness.cleanup();
});

test("createAndConnect does not retry an auth-failed credential", async () => {
  const harness = createHarness(async () => {
    throw new Error("fetch must not be called");
  });
  harness.binding.save({
    connectorId: "connector-1",
    serverUrl: "https://server.example",
    name: "Office Mac",
    ownerUserId: "user-1",
    manualDisconnected: false,
  });
  harness.mock.credential = {
    serverUrl: "https://server.example",
    connectorId: "connector-1",
    connectorToken: "expired",
  };
  harness.mock.authFailed = true;

  await harness.service.createAndConnect({ userId: "user-1", userToken: "user-secret" });

  assert.equal(harness.mock.startCalls, 0);
  harness.cleanup();
});

test("reconnect rejects a remote Desktop before rotating a token", async () => {
  let fetched = false;
  const harness = createHarness(async () => {
    fetched = true;
    throw new Error("unexpected fetch");
  });
  harness.binding.save({
    connectorId: "local-connector",
    serverUrl: "https://server.example",
    name: "Office Mac",
    ownerUserId: "user-1",
    manualDisconnected: false,
  });

  await assert.rejects(
    harness.service.reconnectAndConnect({
      userId: "user-1",
      userToken: "user-secret",
      connectorId: "remote-connector",
    }),
    /different Desktop/,
  );
  assert.equal(fetched, false);
  harness.cleanup();
});

test("createAndConnect replaces credentials when the signed-in account changes", async () => {
  const harness = createHarness(async () => Response.json({
    connector: { id: "connector-new", name: "Office Mac" },
    connectorToken: "new-secret",
  }));
  harness.binding.save({
    connectorId: "connector-old",
    serverUrl: "https://server.example",
    name: "Office Mac",
    ownerUserId: "user-old",
    manualDisconnected: false,
  });
  harness.mock.credential = {
    serverUrl: "https://server.example",
    connectorId: "connector-old",
    connectorToken: "old-secret",
  };

  const result = await harness.service.createAndConnect({
    userId: "user-new",
    userToken: "new-user-token",
  });

  assert.equal(harness.mock.stopCalls, 1);
  assert.equal(harness.mock.clearCalls, 0);
  assert.equal(result.connectorId, "connector-new");
  assert.equal(result.ownerUserId, "user-new");
  harness.cleanup();
});

test("account-switch provisioning failure preserves and resumes the previous Connector", async () => {
  const harness = createHarness(async () => {
    throw new Error("new account is temporarily unavailable");
  });
  harness.binding.save({
    connectorId: "connector-old",
    serverUrl: "https://server.example",
    name: "Office Mac",
    ownerUserId: "user-old",
    manualDisconnected: false,
  });
  const oldCredential = {
    serverUrl: "https://server.example",
    connectorId: "connector-old",
    connectorToken: "old-secret",
  };
  harness.mock.credential = oldCredential;
  harness.mock.running = true;

  await assert.rejects(
    harness.service.createAndConnect({
      userId: "user-new",
      userToken: "new-user-token",
    }),
    /temporarily unavailable/,
  );

  assert.deepEqual(harness.mock.credential, oldCredential);
  assert.equal(harness.binding.get()?.connectorId, "connector-old");
  assert.equal(harness.binding.get()?.ownerUserId, "user-old");
  assert.equal(harness.mock.stopCalls, 1);
  assert.equal(harness.mock.startCalls, 1);
  assert.equal(harness.mock.running, true);
  harness.cleanup();
});

test("disconnectLocal discards the rotated token and keeps the local binding", async () => {
  const harness = createHarness(async () => Response.json({
    connector: { id: "connector-1", name: "Office Mac" },
    connectorToken: "discard-me",
  }));
  harness.binding.save({
    connectorId: "connector-1",
    serverUrl: "https://server.example",
    name: "Office Mac",
    ownerUserId: "user-1",
    manualDisconnected: false,
  });

  const result = await harness.service.disconnectLocal({
    userId: "user-1",
    userToken: "user-secret",
  });

  assert.equal(harness.mock.saveCalls.length, 0);
  assert.equal(harness.mock.clearCalls, 1);
  assert.equal(result.connectorId, "connector-1");
  assert.equal(result.manualDisconnected, true);
  assert.equal(result.hasCredential, false);
  harness.cleanup();
});

function createHarness(fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-device-test-"));
  const binding = new DesktopBindingStore(path.join(directory, "binding.json"));
  const mock: ConnectorMock = {
    credential: null,
    running: false,
    authFailed: false,
    saveCalls: [],
    startCalls: 0,
    stopCalls: 0,
    restartCalls: 0,
    clearCalls: 0,
    preflightCalls: 0,
  };
  const connector = {
    hasCredential: () => Boolean(mock.credential?.connectorToken),
    loadPrivateConfig: () => mock.credential,
    publicState: () => ({ running: mock.running, authFailed: mock.authFailed }),
    preflightProvisioning: async () => {
      mock.preflightCalls += 1;
      return {};
    },
    saveCredentials: async (config: ConnectorPrivateConfig) => {
      mock.credential = config;
      mock.saveCalls.push(config);
      return { ...config, connectorToken: undefined, hasCredential: true };
    },
    start: async () => {
      mock.running = true;
      mock.startCalls += 1;
      return {};
    },
    stop: async () => {
      mock.running = false;
      mock.stopCalls += 1;
      return {};
    },
    restart: async () => {
      mock.running = true;
      mock.restartCalls += 1;
      return {};
    },
    clearCredentials: async () => {
      mock.credential = null;
      mock.running = false;
      mock.clearCalls += 1;
      return {};
    },
    bindingChanged: () => ({}),
  } as unknown as ConnectorSupervisor;
  const service = new DesktopDeviceService({
    binding,
    connector,
    fetcher,
    defaultServerUrl: () => "https://server.example",
    apiNamespace: () => "/api/v2",
  });
  return {
    service,
    binding,
    mock,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
