import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { generateE2EKey, MeshCallError, PermissionDeniedError } from "meshcall";

import type { PairedClientEntry } from "../src/core/config.js";
import { DeviceGate, PAIRING_URI_PREFIX, PairingError, base64UrlEncode, isPairingExpired, parsePairingUri } from "../src/core/gate.js";

// ajv and ajv-formats are CommonJS; under NodeNext ESM the default import is `module.exports`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const SCHEMA_URL = new URL("../../../contracts/aa-v3/1.0/pairing.schema.json", import.meta.url);

async function pairingValidators() {
  const schema = JSON.parse(await readFile(SCHEMA_URL, "utf8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const payload = ajv.getSchema(`${schema.$id}#/$defs/PairingPayload`);
  const entry = ajv.getSchema(`${schema.$id}#/$defs/PairedClientEntry`);
  assert.ok(payload && entry, "pairing schema defs resolve");
  return { payload, entry };
}

class Clock {
  constructor(public ms = Date.parse("2026-11-21T08:00:00.000Z")) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

async function newGate(options: Partial<ConstructorParameters<typeof DeviceGate>[0]> = {}) {
  const clock = new Clock();
  const gate = await DeviceGate.create({ instanceId: "dev_01", now: clock.now, ...options });
  return { gate, clock };
}

async function clientKey(): Promise<string> {
  return (await generateE2EKey()).publicKey;
}

function deniedWith(reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PermissionDeniedError, `expected PermissionDeniedError, got ${String(error)}`);
    assert.equal(error.code, "permission_denied");
    assert.equal(error.reason, reason);
    return true;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pairing payload", () => {
  it("matches contracts/aa-v3/1.0/pairing.schema.json and round-trips through the URI", async () => {
    const { payload: validatePayload } = await pairingValidators();
    const { gate } = await newGate();
    const { uri, payload } = await gate.createPairing();

    assert.ok(validatePayload(payload), JSON.stringify(validatePayload.errors));
    assert.equal(payload.v, 1);
    assert.equal(payload.instance_id, "dev_01");
    assert.equal(payload.device_pub, gate.e2ePublicKey);
    assert.ok(payload.pairing_id.length >= 16);
    assert.match(payload.psk, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(payload.expires_at, "2026-11-21T08:05:00.000Z");

    assert.ok(uri.startsWith(PAIRING_URI_PREFIX));
    assert.deepEqual(DeviceGate.parsePairingUri(uri), payload);
    assert.equal(isPairingExpired(payload, Date.parse("2026-11-21T08:04:59Z")), false);
    assert.equal(isPairingExpired(payload, Date.parse("2026-11-21T08:05:00Z")), true);
  });

  it("generates a fresh id and PSK for every pairing", async () => {
    const { gate } = await newGate();
    const a = await gate.createPairing();
    const b = await gate.createPairing();
    assert.notEqual(a.payload.pairing_id, b.payload.pairing_id);
    assert.notEqual(a.payload.psk, b.payload.psk);
    assert.equal(gate.listPendingPairings().length, 2);
  });

  it("rejects bad prefixes, damaged base64 and payloads off the schema with invalid_pairing_uri", async () => {
    const { payload } = await (await newGate()).gate.createPairing();
    const encode = (value: unknown) => PAIRING_URI_PREFIX + base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
    const bad = [
      "https://example.com/pair",
      "aa-pair://v2/" + encode(payload).slice(PAIRING_URI_PREFIX.length),
      PAIRING_URI_PREFIX + "%%%not-base64%%%",
      PAIRING_URI_PREFIX + base64UrlEncode(new TextEncoder().encode("{not json")),
      encode({ ...payload, v: 2 }),
      encode({ ...payload, psk: "short" }),
      encode({ ...payload, extra: true }),
      encode({ ...payload, expires_at: "tomorrow" }),
    ];
    for (const uri of bad) {
      assert.throws(
        () => parsePairingUri(uri),
        (error: unknown) => error instanceof PairingError && error.code === "invalid_pairing_uri",
        uri,
      );
    }
  });
});

describe("one-time PSK", () => {
  it("getPairingPsk reads without spending", async () => {
    const { gate } = await newGate();
    const { payload } = await gate.createPairing();
    assert.equal(gate.getPairingPsk(payload.pairing_id), payload.psk);
    assert.equal(gate.getPairingPsk(payload.pairing_id), payload.psk);
    assert.equal(gate.getPairingPsk("unknown-pairing-id"), undefined);
  });

  it("pairs a client once and records an entry valid against the contract", async () => {
    const { entry: validateEntry } = await pairingValidators();
    const persisted: PairedClientEntry[][] = [];
    const paired: PairedClientEntry[] = [];
    const { gate } = await newGate({ onStateChange: (list) => void persisted.push(list), onClientPaired: (e) => void paired.push(e) });
    const { payload } = await gate.createPairing(undefined, { label: "t4's iPhone", platform: "ios" });
    const peerKey = await clientKey();

    assert.equal(await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id }), true);
    assert.equal(gate.getPairingPsk(payload.pairing_id), undefined, "spent");
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id }), false, "second use refused");

    const [entry] = gate.listPairedClients();
    assert.ok(entry);
    assert.ok(validateEntry(entry), JSON.stringify(validateEntry.errors));
    assert.equal(entry.client_pub, peerKey);
    assert.equal(entry.label, "t4's iPhone");
    assert.equal(entry.platform, "ios");
    assert.deepEqual(persisted.at(-1), [entry]);
    assert.deepEqual(paired, [entry]);
  });

  it("lets exactly one of two concurrent handshakes with the same pairing id succeed", async () => {
    const { gate } = await newGate();
    const { payload } = await gate.createPairing();
    const [a, b] = [await clientKey(), await clientKey()];
    const results = await Promise.all([
      gate.authorizePeer({ peerKey: a, pairingId: payload.pairing_id }),
      gate.authorizePeer({ peerKey: b, pairingId: payload.pairing_id }),
    ]);
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal(gate.listPairedClients().length, 1);
  });

  it("stays one-time while a slow local confirmation is pending", async () => {
    let asked = 0;
    const { gate } = await newGate({
      requirePairingConfirm: true,
      onPairingConfirm: async () => {
        asked++;
        await sleep(20);
        return true;
      },
    });
    const { payload } = await gate.createPairing();
    const results = await Promise.all(
      await Promise.all([clientKey(), clientKey(), clientKey()]).then((keys) =>
        keys.map((peerKey) => gate.authorizePeer({ peerKey, pairingId: payload.pairing_id })),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(asked, 1, "only the winner is asked");
  });

  it("refuses an expired pairing", async () => {
    const { gate, clock } = await newGate();
    const { payload } = await gate.createPairing(60_000);
    clock.advance(60_000);
    assert.equal(gate.getPairingPsk(payload.pairing_id), undefined);
    assert.equal(await gate.authorizePeer({ peerKey: await clientKey(), pairingId: payload.pairing_id }), false);
    assert.equal(gate.listPairedClients().length, 0);
  });

  it("refuses handshakes without a client key", async () => {
    const { gate } = await newGate();
    const { payload } = await gate.createPairing();
    assert.equal(await gate.authorizePeer({ peerKey: null, pairingId: payload.pairing_id }), false);
    assert.equal(await gate.authorizePeer({ peerKey: "", pairingId: null }), false);
    assert.equal(gate.getPairingPsk(payload.pairing_id), payload.psk, "an NK attempt does not burn the pairing");
  });

  it("rolls the new client back when the allowlist cannot be persisted", async () => {
    const { gate } = await newGate({
      onStateChange: () => {
        throw new Error("disk full");
      },
    });
    const { payload } = await gate.createPairing();
    assert.equal(await gate.authorizePeer({ peerKey: await clientKey(), pairingId: payload.pairing_id }), false);
    assert.equal(gate.listPairedClients().length, 0);
  });
});

describe("local pairing confirmation", () => {
  it("is off by default: the hook is never asked", async () => {
    let asked = false;
    const { gate } = await newGate({
      onPairingConfirm: () => {
        asked = true;
        return false;
      },
    });
    assert.equal(gate.requirePairingConfirm, false);
    const { payload } = await gate.createPairing();
    assert.equal(await gate.authorizePeer({ peerKey: await clientKey(), pairingId: payload.pairing_id }), true);
    assert.equal(asked, false);
  });

  it("when on, pairs only after the person at the device accepts", async () => {
    const seen: { peerKey: string; pairingId: string }[] = [];
    const { gate } = await newGate({ requirePairingConfirm: true, onPairingConfirm: (peer) => (seen.push(peer), true) });
    const { payload } = await gate.createPairing();
    const peerKey = await clientKey();
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id }), true);
    assert.deepEqual(seen, [{ peerKey, pairingId: payload.pairing_id }]);
    assert.ok(gate.isPaired(peerKey));
  });

  it("when on, a rejection pairs nothing and still spends the pairing", async () => {
    const { gate } = await newGate({ requirePairingConfirm: true, onPairingConfirm: async () => false });
    const { payload } = await gate.createPairing();
    const peerKey = await clientKey();
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id }), false);
    assert.equal(gate.isPaired(peerKey), false);
    assert.equal(gate.getPairingPsk(payload.pairing_id), undefined);
  });

  it("when on without a hook, fails closed", async () => {
    const { gate } = await newGate({ requirePairingConfirm: true });
    const { payload } = await gate.createPairing();
    assert.equal(await gate.authorizePeer({ peerKey: await clientKey(), pairingId: payload.pairing_id }), false);
  });
});

describe("paired connections (IK) and revocation", () => {
  it("accepts paired keys without a pairing id, updates last_seen_at, refuses others", async () => {
    const { gate, clock } = await newGate();
    const { payload } = await gate.createPairing();
    const peerKey = await clientKey();
    await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id });

    clock.advance(3_600_000);
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: null }), true);
    assert.equal(gate.listPairedClients()[0]?.last_seen_at, "2026-11-21T09:00:00.000Z");
    assert.equal(await gate.authorizePeer({ peerKey: await clientKey(), pairingId: null }), false);
  });

  it("restores the allowlist from saved entries", async () => {
    const peerKey = await clientKey();
    const { gate } = await newGate({
      pairedClients: [{ client_pub: peerKey, label: "Desktop", platform: "desktop", paired_at: "2026-11-01T00:00:00Z" }],
    });
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: null }), true);
  });

  it("revoking a client refuses its next handshake and its calls", async () => {
    const { gate } = await newGate({ mode: "encrypted" });
    const { payload } = await gate.createPairing();
    const peerKey = await clientKey();
    await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id });
    const ctx = { e2e: { peerKey }, tunnel: { id: "tun_1", principal: "user:1/client:a", sealed: true }, metadata: {} };
    assert.deepEqual(gate.assertBusinessCallAllowed(ctx), { via: "tunnel", clientPub: peerKey });

    assert.equal(gate.revokePairedClient(peerKey), true);
    assert.equal(gate.revokePairedClient(peerKey), false);
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: null }), false);
    assert.throws(() => gate.assertBusinessCallAllowed(ctx), deniedWith("e2e_not_paired"));
  });
});

describe("assertBusinessCallAllowed", () => {
  const tunnel = { id: "tun_1", principal: "user:1/client:a", sealed: false };

  it("encrypted: only paired, authenticated E2E peers get through", async () => {
    const { gate } = await newGate({ mode: "encrypted", allowMcp: true });
    const { payload } = await gate.createPairing();
    const peerKey = await clientKey();
    await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id });

    assert.deepEqual(gate.assertBusinessCallAllowed({ e2e: { peerKey }, tunnel: { ...tunnel, sealed: true } }), { via: "tunnel", clientPub: peerKey });
    // control-plane direct call (aggregation)
    assert.throws(() => gate.assertBusinessCallAllowed({ metadata: { "aa-via": "client", "aa-on-behalf-of": "user:1" } }), deniedWith("e2e_peer_required"));
    // plain tunnel
    assert.throws(() => gate.assertBusinessCallAllowed({ tunnel, e2e: null }), deniedWith("e2e_peer_required"));
    // NK session: sealed but the client is anonymous
    assert.throws(() => gate.assertBusinessCallAllowed({ tunnel: { ...tunnel, sealed: true }, e2e: { peerKey: null } }), deniedWith("e2e_peer_required"));
    // authenticated but unknown key
    const stranger = await clientKey();
    assert.throws(() => gate.assertBusinessCallAllowed({ e2e: { peerKey: stranger }, tunnel }), deniedWith("e2e_not_paired"));
    // MCP, even with allowMcp on
    assert.throws(() => gate.assertBusinessCallAllowed({ metadata: { "aa-via": "mcp" } }), deniedWith("e2e_peer_required"));
    assert.throws(() => gate.assertBusinessCallAllowed({ e2e: { peerKey }, tunnel, metadata: { "aa-via": "mcp" } }), deniedWith("e2e_peer_required"));
  });

  it("normal: tunnels and control-plane fan-out are allowed", async () => {
    const { gate } = await newGate();
    assert.deepEqual(gate.assertBusinessCallAllowed({ tunnel, e2e: null, metadata: {} }), { via: "tunnel" });
    assert.deepEqual(gate.assertBusinessCallAllowed({ metadata: { "aa-via": "client", "aa-on-behalf-of": "user:42" } }), {
      via: "control",
      onBehalfOf: "user:42",
    });
    assert.deepEqual(gate.assertBusinessCallAllowed({}), { via: "control" });
  });

  it("normal: MCP needs allowMcp", async () => {
    const { gate } = await newGate();
    const mcp = { metadata: { "aa-via": "mcp", "aa-on-behalf-of": "user:42", "aa-mcp-client": "cursor" } };
    assert.throws(() => gate.assertBusinessCallAllowed(mcp), deniedWith("mcp_disabled_on_device"));
    // a tunnel claiming MCP is held to the same switch
    assert.throws(() => gate.assertBusinessCallAllowed({ ...mcp, tunnel }), deniedWith("mcp_disabled_on_device"));

    gate.allowMcp = true;
    assert.deepEqual(gate.assertBusinessCallAllowed(mcp), { via: "mcp", onBehalfOf: "user:42", mcpClient: "cursor" });
  });

  it("switching a device to encrypted closes the normal entrances at once", async () => {
    const { gate } = await newGate({ allowMcp: true });
    assert.equal(gate.assertBusinessCallAllowed({ tunnel }).via, "tunnel");
    gate.mode = "encrypted";
    assert.throws(() => gate.assertBusinessCallAllowed({ tunnel }), (error: unknown) => error instanceof MeshCallError);
  });
});
