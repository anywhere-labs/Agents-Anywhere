import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { SecureStore, SecureStoreError, type SecretCipher } from "../src/main/secure-store";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aa-dv3-ss-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Stand-in for safeStorage: reversible, but the stored bytes never contain the plain text. */
function fakeCipher(available = true): SecretCipher & { available: boolean; stale: boolean } {
  return {
    available,
    stale: false,
    async isAvailable() {
      return this.available;
    },
    async encrypt(plain) {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return Buffer.from(`v1:${Buffer.from(plain, "utf8").reverse().toString("hex")}`);
    },
    async decrypt(encrypted) {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("v1:")) throw new Error("bad ciphertext");
      return { result: Buffer.from(text.slice(3), "hex").reverse().toString("utf8"), shouldReEncrypt: this.stale };
    },
  };
}

describe("SecureStore", () => {
  it("stores, reads and deletes secrets without writing plain text", async () => {
    const file = path.join(tmp, "a", "secure-store.json");
    const store = new SecureStore(file, fakeCipher());
    assert.equal(await store.get("client_identity.private_key"), null);
    await store.set("client_identity.private_key", "super-secret-key");
    await store.set("account./api/control::usr_1.refresh_token", "rt_123");
    assert.equal(await store.get("client_identity.private_key"), "super-secret-key");
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("super-secret-key"));
    assert.ok(!raw.includes("rt_123"));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    // A fresh instance reads the same file.
    const again = new SecureStore(file, fakeCipher());
    assert.equal(await again.get("account./api/control::usr_1.refresh_token"), "rt_123");
    await again.delete("account./api/control::usr_1.refresh_token");
    assert.equal(await again.get("account./api/control::usr_1.refresh_token"), null);
    assert.deepEqual(again.keys(), ["client_identity.private_key"]);
    await again.delete("not-there");
  });

  it("does not lose concurrent writes", async () => {
    const store = new SecureStore(path.join(tmp, "concurrent.json"), fakeCipher());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, `v${i}`)));
    const fresh = new SecureStore(path.join(tmp, "concurrent.json"), fakeCipher());
    assert.equal(fresh.keys().length, 20);
    assert.equal(await fresh.get("k13"), "v13");
  });

  it("rejects bad keys and values", async () => {
    const store = new SecureStore(path.join(tmp, "b.json"), fakeCipher());
    for (const key of ["", "x".repeat(300), "k\n", "tab\tkey", 7 as unknown as string]) {
      assert.throws(() => store.set(key, "v"), SecureStoreError);
      await assert.rejects(store.get(key), SecureStoreError);
    }
    assert.throws(() => store.set("k", 42 as unknown as string), SecureStoreError);
    assert.throws(() => store.set("k", "x".repeat(70_000)), SecureStoreError);
  });

  it("refuses to write when the keychain is unavailable", async () => {
    const cipher = fakeCipher(false);
    const store = new SecureStore(path.join(tmp, "c.json"), cipher);
    assert.equal(await store.available(), false);
    await assert.rejects(store.set("k", "v"), /keychain/);
    cipher.available = true;
    await store.set("k", "v");
    cipher.available = false;
    await assert.rejects(store.get("k"), /keychain/);
  });

  it("treats values it cannot decrypt as missing, and re-seals stale ones", async () => {
    const file = path.join(tmp, "d.json");
    writeFileSync(file, JSON.stringify({ k: Buffer.from("garbage").toString("base64") }));
    const cipher = fakeCipher();
    const store = new SecureStore(file, cipher);
    assert.equal(await store.get("k"), null);
    await store.set("k2", "value");
    cipher.stale = true;
    assert.equal(await store.get("k2"), "value");
  });

  it("starts empty when the file is corrupt", async () => {
    const file = path.join(tmp, "e.json");
    writeFileSync(file, "{not json");
    const store = new SecureStore(file, fakeCipher());
    assert.deepEqual(store.keys(), []);
    await store.set("k", "v");
    assert.equal(await new SecureStore(file, fakeCipher()).get("k"), "v");
  });
});
