import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "./log-store";

test("redactSecrets covers JSON and key-value Connector tokens", () => {
  assert.equal(
    redactSecrets('{"connectorToken":"json-secret","connectorId":"connector-1"}'),
    '{"connectorToken":"[REDACTED]","connectorId":"connector-1"}',
  );
  assert.equal(
    redactSecrets("connectorToken=key-value-secret connectorId=connector-1"),
    "connectorToken=[REDACTED] connectorId=connector-1",
  );
});

test("redactSecrets covers Bearer and Connector authorization headers", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer user-secret"),
    "Authorization: Bearer [REDACTED]",
  );
  assert.equal(
    redactSecrets('{"authorization":"Connector connector-secret"}'),
    '{"authorization":"Connector [REDACTED]"}',
  );
});
