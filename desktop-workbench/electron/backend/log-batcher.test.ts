import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorLogEntry } from "../connector-types";
import { LogBatcher } from "./log-batcher";

const entry = (seq: number): ConnectorLogEntry => ({
  seq,
  level: "INFO",
  message: `line ${seq}`,
  time: "2026-01-01T00:00:00.000Z",
});

test("a burst of log lines becomes one batch after the interval", async () => {
  const batches: ConnectorLogEntry[][] = [];
  const batcher = new LogBatcher((batch) => batches.push(batch), 20);
  for (let seq = 1; seq <= 5; seq += 1) batcher.push(entry(seq));
  assert.equal(batches.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(batches.map((batch) => batch.length), [5]);
  assert.equal(batches[0]?.[0]?.seq, 1);
  assert.equal(batches[0]?.[4]?.seq, 5);
});

test("the batch ceiling flushes immediately and dispose drains the remainder", () => {
  const batches: ConnectorLogEntry[][] = [];
  const batcher = new LogBatcher((batch) => batches.push(batch), 1_000, 3);
  for (let seq = 1; seq <= 3; seq += 1) batcher.push(entry(seq));
  assert.deepEqual(batches.map((batch) => batch.length), [3]);
  batcher.push(entry(4));
  batcher.dispose();
  assert.deepEqual(batches.map((batch) => batch.length), [3, 1]);
});
