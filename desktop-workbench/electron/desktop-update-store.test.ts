import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopUpdateStore } from "./desktop-update-store";

const RELEASE = {
  versionCode: 7,
  versionName: "0.1.7.3",
  downloadUrl: "https://example.test/app.dmg",
};

test("update choices and known minimums coexist in the protected state file", () => {
  const harness = createHarness();
  try {
    const decision = harness.store.save(
      RELEASE,
      "declined",
      "https://example.test",
      "2026-09-05T00:00:00.000Z",
    );
    harness.store.saveKnownMinimum(
      "https://example.test",
      "0.1.7.3",
      "2026-09-05T00:01:00.000Z",
    );

    assert.deepEqual(
      harness.store.get("https://example.test", 7, "0.1.7.3"),
      decision,
    );
    assert.deepEqual(harness.store.getKnownMinimum("https://example.test"), {
      serverOrigin: "https://example.test",
      version: "0.1.7.3",
      confirmedAt: "2026-09-05T00:01:00.000Z",
    });
    assert.equal(fs.statSync(harness.filePath).mode & 0o777, 0o600);

    const persisted = readState(harness.filePath);
    assert.equal(persisted.schemaVersion, 2);
    assert.equal((persisted.decisions as unknown[]).length, 1);
    assert.equal((persisted.knownMinimumVersions as unknown[]).length, 1);
  } finally {
    harness.cleanup();
  }
});

test("release decisions are bounded and retained per backend", () => {
  const harness = createHarness();
  try {
    harness.store.save(RELEASE, "declined", "https://one.example");
    harness.store.save(RELEASE, "declined", "https://two.example");
    assert.equal(
      harness.store.get("https://one.example", RELEASE.versionCode, RELEASE.versionName)?.decision,
      "declined",
    );
    assert.equal(
      harness.store.get("https://two.example", RELEASE.versionCode, RELEASE.versionName)?.decision,
      "declined",
    );

    harness.store.save(RELEASE, "accepted", "https://one.example");
    assert.equal(
      harness.store.get("https://one.example", RELEASE.versionCode, RELEASE.versionName)?.decision,
      "accepted",
      "a new choice replaces only the matching backend and release",
    );
    assert.equal(
      harness.store.get("https://two.example", RELEASE.versionCode, RELEASE.versionName)?.decision,
      "declined",
    );

    for (let index = 0; index < 40; index += 1) {
      harness.store.save(
        { ...RELEASE, versionCode: 100 + index, versionName: `1.0.${index}` },
        "declined",
        "https://many.example",
      );
    }
    assert.equal((readState(harness.filePath).decisions as unknown[]).length, 32);
  } finally {
    harness.cleanup();
  }
});

test("schema 1 decisions migrate without being lost", () => {
  const harness = createHarness();
  try {
    fs.writeFileSync(harness.filePath, JSON.stringify({
      schemaVersion: 1,
      serverOrigin: "https://example.test",
      versionCode: 7,
      versionName: "0.1.7.3",
      decision: "declined",
      decidedAt: "2026-09-05T00:00:00.000Z",
    }));

    assert.equal(
      harness.store.get("https://example.test", 7, "0.1.7.3")?.decision,
      "declined",
    );
    harness.store.saveKnownMinimum("https://example.test", "0.1.7.3");

    const migrated = readState(harness.filePath);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal((migrated.decisions as unknown[]).length, 1);
    assert.equal((migrated.knownMinimumVersions as unknown[]).length, 1);
  } finally {
    harness.cleanup();
  }
});

test("legacy choices without a server origin never suppress prompts", () => {
  const harness = createHarness();
  try {
    fs.writeFileSync(harness.filePath, JSON.stringify({
      schemaVersion: 1,
      versionCode: 7,
      versionName: "0.1.7.3",
      decision: "declined",
      decidedAt: "2026-09-05T00:00:00.000Z",
    }));
    assert.equal(harness.store.get("https://example.test", 7, "0.1.7.3"), null);
  } finally {
    harness.cleanup();
  }
});

test("clearing one backend minimum preserves decisions and other backends", () => {
  const harness = createHarness();
  try {
    harness.store.save(RELEASE, "declined", "https://one.example");
    harness.store.saveKnownMinimum("https://one.example", "0.1.7.3");
    harness.store.saveKnownMinimum("https://two.example", "0.2.0");

    harness.store.clearKnownMinimum("https://one.example");

    assert.equal(harness.store.getKnownMinimum("https://one.example"), null);
    assert.equal(harness.store.getKnownMinimum("https://two.example")?.version, "0.2.0");
    assert.equal(
      harness.store.get("https://one.example", RELEASE.versionCode, RELEASE.versionName)?.decision,
      "declined",
    );
  } finally {
    harness.cleanup();
  }
});

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-update-store-"));
  const filePath = path.join(directory, "state.json");
  return {
    filePath,
    store: new DesktopUpdateStore(filePath),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function readState(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}
