import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopDeviceService } from "./desktop-device-service";
import { MachineStateStore, machineStatePath } from "./machine-state";
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
    if (init?.method === "GET") return Response.json({ connectors: [] });
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

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://server.example/api/v2/connectors");
  assert.equal(requests[0].init?.method, "GET");
  assert.equal(requests[1].url, "https://server.example/api/v2/connectors");
  assert.equal(requests[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    name: "Office Mac",
    connectorKind: "desktop",
  });
  assert.equal(harness.mock.saveCalls[0].connectorToken, "connector-secret");
  assert.equal(harness.mock.startCalls, 1);
  assert.equal(harness.mock.preflightCalls, 1);
  assert.equal(result.connectorId, "connector-1");
  assert.equal(result.ownerUserId, "user-1");
  assert.equal("connectorToken" in result, false);
  assert.deepEqual(harness.shared().connectorIds, ["connector-1"]);
  assert.doesNotMatch(JSON.stringify(harness.shared()), /connector-secret|user-secret|Token/);
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

test("reconnect rotates credentials for an existing local Desktop without creating a device", async (t) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const harness = createHarness(async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      connector: { id: "connector-old", name: "Renamed Mac" },
      connectorToken: "rotated-secret",
    });
  });
  t.after(harness.cleanup);
  seedLocalConnector(harness);

  const result = await harness.service.reconnectAndConnect({
    userId: "user-1",
    userToken: "user-secret",
    connectorId: "connector-old",
  });

  assert.deepEqual(requests.map((request) => request.url), [
    "https://server.example/api/v2/connectors/connector-old/revoke",
  ]);
  assert.equal(result.connectorId, "connector-old");
  assert.equal(result.name, "Renamed Mac");
  assert.equal(result.manualDisconnected, false);
  assert.equal(result.hasCredential, true);
  assert.equal(harness.mock.credential?.connectorToken, "rotated-secret");
  assert.equal(harness.mock.restartCalls, 1);
  assert.equal(harness.mock.preflightCalls, 0);
  assert.equal(harness.shared(), null);
});

for (const hasCredential of [true, false]) {
  test(`reconnect pairs a deleted local Desktop again (stored credential: ${hasCredential})`, async (t) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const harness = createHarness(async (input, init) => {
      requests.push({ url: String(input), init });
      if (init?.method === "GET") return Response.json({ connectors: [] });
      if (String(input).endsWith("/connector-old/revoke")) {
        return Response.json({ detail: "connector not found" }, { status: 404 });
      }
      return Response.json({
        connector: { id: "connector-new", name: "Office Mac" },
        connectorToken: "new-secret",
      });
    });
    t.after(harness.cleanup);
    seedLocalConnector(harness);
    if (!hasCredential) harness.mock.credential = null;

    const result = await harness.service.reconnectAndConnect({
      userId: "user-1",
      userToken: "user-secret",
      connectorId: "connector-old",
    });

    assert.deepEqual(requests.map((request) => [request.url, request.init?.method]), [
      ["https://server.example/api/v2/connectors/connector-old/revoke", "POST"],
      ["https://server.example/api/v2/connectors", "GET"],
      ["https://server.example/api/v2/connectors", "POST"],
    ]);
    assert.equal(new Headers(requests[1].init?.headers).get("authorization"), "Bearer user-secret");
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
      name: "Office Mac",
      connectorKind: "desktop",
    });
    assert.deepEqual(result, {
      connectorId: "connector-new",
      serverUrl: "https://server.example",
      name: "Office Mac",
      ownerUserId: "user-1",
      manualDisconnected: false,
      hasCredential: true,
    });
    assert.equal(harness.binding.get()?.connectorId, "connector-new");
    assert.deepEqual(harness.mock.credential, {
      serverUrl: "https://server.example",
      connectorId: "connector-new",
      connectorToken: "new-secret",
    });
    assert.equal(harness.mock.stopCalls, 1);
    assert.equal(harness.mock.preflightCalls, 1);
    assert.equal(harness.mock.startCalls, 1);
    assert.equal(harness.mock.restartCalls, 0);
    assert.equal(harness.mock.clearCalls, 0);
  });
}

for (const status of [401, 403, 409, 500]) {
  test(`reconnect does not create a replacement device after HTTP ${status}`, async (t) => {
    let requests = 0;
    const harness = createHarness(async () => {
      requests += 1;
      return Response.json({ detail: "reconnect failed" }, { status });
    });
    t.after(harness.cleanup);
    seedLocalConnector(harness);
    const previousBinding = harness.binding.get();
    const previousCredential = harness.mock.credential;

    await assert.rejects(harness.service.reconnectAndConnect({
      userId: "user-1",
      userToken: "user-secret",
    }));

    assert.equal(requests, 1);
    assert.deepEqual(harness.binding.get(), previousBinding);
    assert.deepEqual(harness.mock.credential, previousCredential);
    assert.equal(harness.mock.preflightCalls, 0);
    assert.equal(harness.mock.stopCalls, 0);
    assert.equal(harness.mock.saveCalls.length, 0);
  });
}

test("reconnect does not infer a deleted device from an arbitrary error message", async (t) => {
  let requests = 0;
  const error = new Error("The selected Connector no longer exists.");
  const harness = createHarness(async () => {
    requests += 1;
    throw error;
  });
  t.after(harness.cleanup);
  seedLocalConnector(harness);

  await assert.rejects(harness.service.reconnectAndConnect({
    userId: "user-1",
    userToken: "user-secret",
  }), (received) => received === error);

  assert.equal(requests, 1);
  assert.equal(harness.mock.preflightCalls, 0);
});

test("failed replacement provisioning preserves the local binding for another reconnect", async (t) => {
  let creates = 0;
  const harness = createHarness(async (input, init) => {
    if (init?.method === "GET") return Response.json({ connectors: [] });
    if (String(input).endsWith("/connector-old/revoke")) {
      return Response.json({ detail: "connector not found" }, { status: 404 });
    }
    creates += 1;
    if (creates === 1) {
      return Response.json({ detail: "temporarily unavailable" }, { status: 503 });
    }
    return Response.json({
      connector: { id: "connector-new", name: "Office Mac" },
      connectorToken: "new-secret",
    });
  });
  t.after(harness.cleanup);
  seedLocalConnector(harness);
  const previousBinding = harness.binding.get();
  const previousCredential = harness.mock.credential;
  const input = { userId: "user-1", userToken: "user-secret", connectorId: "connector-old" };

  await assert.rejects(harness.service.reconnectAndConnect(input), /temporarily unavailable/);
  assert.deepEqual(harness.binding.get(), previousBinding);
  assert.deepEqual(harness.mock.credential, previousCredential);
  assert.equal(harness.mock.startCalls, 0);
  assert.equal(harness.mock.clearCalls, 0);

  const result = await harness.service.reconnectAndConnect(input);
  assert.equal(result.connectorId, "connector-new");
  assert.equal(creates, 2);
  assert.equal(harness.mock.startCalls, 1);
});

test("replacement provisioning rolls back a new server device if its local binding cannot be saved", async (t) => {
  const requests: Array<{ url: string; method?: string }> = [];
  const harness = createHarness(async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method });
    if (init?.method === "GET") return Response.json({ connectors: [] });
    if (url.endsWith("/connector-old/revoke")) {
      return Response.json({ detail: "connector not found" }, { status: 404 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({
      connector: { id: "connector-new", name: "Office Mac" },
      connectorToken: "new-secret",
    });
  });
  t.after(harness.cleanup);
  seedLocalConnector(harness);
  const previousBinding = harness.binding.get();
  const previousCredential = harness.mock.credential;
  t.mock.method(harness.binding, "save", () => { throw new Error("disk is full"); });

  await assert.rejects(harness.service.reconnectAndConnect({
    userId: "user-1",
    userToken: "user-secret",
  }), /disk is full/);

  assert.deepEqual(requests, [
    { url: "https://server.example/api/v2/connectors/connector-old/revoke", method: "POST" },
    { url: "https://server.example/api/v2/connectors", method: "GET" },
    { url: "https://server.example/api/v2/connectors", method: "POST" },
    { url: "https://server.example/api/v2/connectors/connector-new", method: "DELETE" },
  ]);
  assert.deepEqual(harness.binding.get(), previousBinding);
  assert.deepEqual(harness.mock.credential, previousCredential);
  assert.equal(harness.mock.saveCalls.length, 0);
});

test("reconnect rejects a different signed-in account before creating a replacement", async (t) => {
  let requests = 0;
  const harness = createHarness(async () => {
    requests += 1;
    return Response.json({ detail: "connector not found" }, { status: 404 });
  });
  t.after(harness.cleanup);
  seedLocalConnector(harness);

  await assert.rejects(harness.service.reconnectAndConnect({
    userId: "another-user",
    userToken: "another-user-secret",
  }), /different signed-in account/);

  assert.equal(requests, 0);
  assert.equal(harness.mock.preflightCalls, 0);
});

test("createAndConnect replaces credentials when the signed-in account changes", async () => {
  const harness = createHarness(async (_input, init) => Response.json(init?.method === "GET" ? { connectors: [] } : {
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
  const harness = createHarness(async (_input, init) => {
    if (init?.method === "GET") return Response.json({ connectors: [] });
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

test("new local IDs persist once and ordinary reuse or token rotation never rewrites the record", async (t) => {
  const harness = createHarness(async (_input, init) => Response.json(init?.method === "GET" ? { connectors: [] } : {
    connector: { id: "connector-1", name: "Local" }, connectorToken: "private",
  }));
  t.after(harness.cleanup);
  const input = { userId: "user-1", userToken: "user-token", name: "Local" };
  await harness.service.createAndConnect(input);
  const before = fs.statSync(harness.machineState.filePath).mtimeMs;
  await harness.service.createAndConnect(input);
  await harness.service.reconnectAndConnect({ ...input, connectorId: "connector-1" });
  assert.deepEqual(harness.shared().connectorIds, ["connector-1"]);
  assert.equal(fs.statSync(harness.machineState.filePath).mtimeMs, before);
});

test("a failed public ID write rolls back the new device before replacing local credentials", async (t) => {
  const requests: string[] = [];
  const harness = createHarness(async (url, init) => {
    requests.push(`${init?.method} ${new URL(url).pathname}`);
    if (init?.method === "GET") return Response.json({ connectors: [] });
    return Response.json({ connector: { id: "new-device", name: "Local" }, connectorToken: "private" });
  });
  t.after(harness.cleanup);
  harness.machineState.recordConnectorId = () => { throw new Error("Cannot write machine record"); };
  await assert.rejects(harness.service.createAndConnect({ userId: "user-1", userToken: "user-token", name: "Local" }), /machine record/);
  assert.deepEqual(requests, ["GET /api/v2/connectors", "POST /api/v2/connectors", "DELETE /api/v2/connectors/new-device"]);
  assert.equal(harness.binding.get(), null);
  assert.equal(harness.mock.saveCalls.length, 0);
  assert.equal(harness.mock.startCalls, 0);
});

for (const entry of ["first-login", "deleted-device"] as const) {
  for (const matches of [1, 2]) {
    test(`${entry} reuses the first shared local ID with ${matches} server matches`, async (t) => {
      const requests: string[] = [];
      const harness = createHarness(async (url, init) => {
        const request = `${init?.method} ${new URL(url).pathname}`;
        requests.push(request);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-token");
        if (request === "POST /api/v2/connectors/connector-old/revoke") {
          return Response.json({ detail: "connector not found" }, { status: 404 });
        }
        if (request === "GET /api/v2/connectors") return Response.json({ connectors: [
          ...(matches === 2 ? [{ id: "shared-second", userId: "user-1" }] : []),
          { id: "shared-first", userId: "user-1" },
          { id: "foreign", userId: "another-user" },
          { id: "remote", userId: "user-1" },
        ] });
        assert.equal(request, "POST /api/v2/connectors/shared-first/revoke");
        assert.equal(init?.body, undefined);
        return Response.json({ connector: { id: "shared-first", name: "Existing Mac" }, connectorToken: "renewed-secret" });
      });
      t.after(harness.cleanup);
      if (entry === "deleted-device") seedLocalConnector(harness);
      for (const id of ["foreign", "connector-old", "shared-first", "shared-second"]) harness.machineState.recordConnectorId(id);
      const before = fs.readFileSync(harness.machineState.filePath, "utf8");
      const timestamp = fs.statSync(harness.machineState.filePath).mtimeMs;
      t.mock.method(harness.machineState, "recordConnectorId", () => { throw new Error("Reused IDs must not be recorded again"); });

      const input = { userId: "user-1", userToken: "user-token", name: "New Name" };
      const result = entry === "first-login"
        ? await harness.service.createAndConnect(input)
        : await harness.service.reconnectAndConnect(input);

      assert.deepEqual(requests, [
        ...(entry === "deleted-device" ? ["POST /api/v2/connectors/connector-old/revoke"] : []),
        "GET /api/v2/connectors", "POST /api/v2/connectors/shared-first/revoke",
      ]);
      assert.deepEqual(result, {
        connectorId: "shared-first", serverUrl: "https://server.example", name: "Existing Mac",
        ownerUserId: "user-1", manualDisconnected: false, hasCredential: true,
      });
      assert.deepEqual(harness.mock.credential, {
        connectorId: "shared-first", serverUrl: "https://server.example", connectorToken: "renewed-secret",
      });
      assert.equal(harness.mock.startCalls, 1);
      assert.equal(harness.mock.restartCalls, 0);
      assert.equal(fs.readFileSync(harness.machineState.filePath, "utf8"), before);
      assert.equal(fs.statSync(harness.machineState.filePath).mtimeMs, timestamp);
    });
  }
}

test("provisioning only creates a new ID when current-user devices do not match the shared history", async (t) => {
  const requests: string[] = [];
  const harness = createHarness(async (url, init) => {
    requests.push(`${init?.method} ${new URL(url).pathname}`);
    if (init?.method === "GET") return Response.json({ connectors: [
      { id: "foreign", userId: "another-user" }, { id: "remote", userId: "user-1" },
    ] });
    return Response.json({ connector: { id: "new-local", name: "Local" }, connectorToken: "secret" });
  });
  t.after(harness.cleanup);
  harness.machineState.recordConnectorId("foreign");
  harness.machineState.recordConnectorId("deleted");

  const result = await harness.service.createAndConnect({ userId: "user-1", userToken: "user-token", name: "Local" });

  assert.equal(result.connectorId, "new-local");
  assert.deepEqual(requests, ["GET /api/v2/connectors", "POST /api/v2/connectors"]);
  assert.deepEqual(harness.shared().connectorIds, ["foreign", "deleted", "new-local"]);
});

for (const failure of ["list", "renewal", "mismatched-credential"] as const) {
  test(`${failure} failure does not fall back to creating a duplicate local device`, async (t) => {
    const requests: string[] = [];
    const harness = createHarness(async (url, init) => {
      const request = `${init?.method} ${new URL(url).pathname}`;
      requests.push(request);
      if (init?.method === "GET") return failure === "list"
        ? Response.json({ detail: "temporarily unavailable" }, { status: 503 })
        : Response.json({ connectors: [{ id: "shared", userId: "user-1" }] });
      assert.equal(request, "POST /api/v2/connectors/shared/revoke");
      return failure === "renewal"
        ? Response.json({ detail: "connector not found" }, { status: 404 })
        : Response.json({ connector: { id: "other" }, connectorToken: "secret" });
    });
    t.after(harness.cleanup);
    harness.machineState.recordConnectorId("shared");

    await assert.rejects(harness.service.createAndConnect({ userId: "user-1", userToken: "user-token", name: "Local" }));

    assert.deepEqual(requests, ["GET /api/v2/connectors", ...(failure === "list" ? [] : ["POST /api/v2/connectors/shared/revoke"])]);
    assert.equal(harness.binding.get(), null);
    assert.equal(harness.mock.saveCalls.length, 0);
    assert.equal(harness.mock.startCalls, 0);
    assert.deepEqual(harness.shared().connectorIds, ["shared"]);
  });
}

for (const payload of [{}, { connectors: null }, { connectors: [null] }, { connectors: [{ id: "shared" }] }]) {
  test(`invalid device list ${JSON.stringify(payload)} stops provisioning`, async (t) => {
    const requests: string[] = [];
    const harness = createHarness(async (url, init) => {
      requests.push(`${init?.method} ${new URL(url).pathname}`);
      return Response.json(payload);
    });
    t.after(harness.cleanup);
    harness.machineState.recordConnectorId("shared");

    await assert.rejects(harness.service.createAndConnect({ userId: "user-1", userToken: "user-token", name: "Local" }), /invalid Connector list/);

    assert.deepEqual(requests, ["GET /api/v2/connectors"]);
    assert.equal(harness.mock.saveCalls.length, 0);
  });
}

test("an unreadable machine record stops provisioning before server changes", async (t) => {
  const harness = createHarness(async () => { throw new Error("fetch must not be called"); });
  t.after(harness.cleanup);
  harness.machineState.recordConnectorId("shared");
  fs.writeFileSync(harness.machineState.filePath, "{broken");

  await assert.rejects(harness.service.createAndConnect({ userId: "user-1", userToken: "user-token", name: "Local" }), /machine record/);

  assert.equal(harness.binding.get(), null);
  assert.equal(harness.mock.saveCalls.length, 0);
  assert.equal(fs.readFileSync(harness.machineState.filePath, "utf8"), "{broken");
});

for (const failure of ["binding", "credentials", "credential-acknowledgement"] as const) {
  test(`a reused server device is preserved after ${failure} persistence fails`, async (t) => {
    const requests: string[] = [];
    const harness = createHarness(async (url, init) => {
      requests.push(`${init?.method} ${new URL(url).pathname}`);
      return Response.json(init?.method === "GET"
        ? { connectors: [{ id: "shared", userId: "user-1" }] }
        : { connector: { id: "shared", name: "Existing" }, connectorToken: "new-secret" });
    });
    t.after(harness.cleanup);
    harness.machineState.recordConnectorId("shared");
    if (failure === "binding") {
      t.mock.method(harness.binding, "save", () => { throw new Error("binding persistence failed"); });
    } else {
      t.mock.method(harness.connector, "saveCredentials", async (config: ConnectorPrivateConfig) => {
        if (failure === "credential-acknowledgement") harness.mock.credential = config;
        throw new Error("credential persistence failed");
      });
    }

    await assert.rejects(harness.service.createAndConnect({ userId: "user-1", userToken: "user-token", name: "Local" }), /persistence failed/);

    assert.deepEqual(requests, ["GET /api/v2/connectors", "POST /api/v2/connectors/shared/revoke"]);
    assert.equal(harness.mock.startCalls, 0);
    if (failure === "credential-acknowledgement") {
      assert.equal(harness.binding.get()?.connectorId, "shared");
      assert.equal(harness.mock.credential?.connectorToken, "new-secret");
    } else {
      assert.equal(harness.binding.get(), null);
      assert.equal(harness.mock.credential, null);
    }
    assert.deepEqual(harness.shared().connectorIds, ["shared"]);
  });
}

function seedLocalConnector(harness: ReturnType<typeof createHarness>): void {
  harness.binding.save({
    connectorId: "connector-old",
    serverUrl: "https://server.example",
    name: "Office Mac",
    ownerUserId: "user-1",
    manualDisconnected: true,
  });
  harness.mock.credential = {
    serverUrl: "https://server.example",
    connectorId: "connector-old",
    connectorToken: "old-secret",
  };
  harness.mock.authFailed = true;
}

function createHarness(fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-device-test-"));
  const binding = new DesktopBindingStore(path.join(directory, "binding.json"));
  const machineState = new MachineStateStore(machineStatePath(directory));
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
    readLocalConnectorIds: () => machineState.readConnectorIds(),
    recordLocalConnector: (id) => machineState.recordConnectorId(id),
  });
  return {
    service,
    binding,
    connector,
    mock,
    machineState,
    shared: () => fs.existsSync(machineState.filePath) ? JSON.parse(fs.readFileSync(machineState.filePath, "utf8")) : null,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
