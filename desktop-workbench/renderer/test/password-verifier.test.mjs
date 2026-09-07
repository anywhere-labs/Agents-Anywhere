import assert from "node:assert/strict"
import { pbkdf2Sync, webcrypto } from "node:crypto"
import test from "node:test"

import { createPasswordVerifier, derivePasswordVerifier } from "../src/features/auth/password-verifier.ts"

const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
const vectors = [
  ["synthetic-login-password", "synthetic-login-salt"],
  ["密码 🔐 café e\u0301", "含中文的盐_-"],
  ["long password 密码 ".repeat(20), "salt"],
  ["password\0with\0nulls", "salt\0suffix"],
  ["", ""],
]

function reference(password, salt) {
  // Same UTF-8, work factor, digest length, and unpadded base64url as
  // server/agent_server/core/auth.py; OpenSSL is independent of the JS fallback.
  return pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("base64url")
}

async function withCrypto(crypto, action) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto })
  try {
    return await action()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor)
    else delete globalThis.crypto
  }
}

test("HTTP password derivation preserves the backend verifier for Unicode, long keys, and byte boundaries", async () => {
  await withCrypto(httpCrypto, async () => {
    for (const [password, salt] of vectors) {
      assert.equal(await derivePasswordVerifier(password, salt), reference(password, salt))
    }
  })
})

test("secure contexts retain native Web Crypto with the same verifier", async () => {
  let nativeCalls = 0
  const crypto = {
    ...httpCrypto,
    subtle: {
      importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
      deriveBits(params, key, bits) {
        nativeCalls++
        assert.equal(params.name, "PBKDF2")
        assert.equal(params.hash, "SHA-256")
        assert.equal(params.iterations, 120_000)
        assert.equal(bits, 256)
        return webcrypto.subtle.deriveBits(params, key, bits)
      },
    },
  }
  await withCrypto(crypto, async () => {
    for (const [password, salt] of vectors) {
      assert.equal(await derivePasswordVerifier(password, salt), reference(password, salt))
    }
  })
  assert.equal(nativeCalls, vectors.length)
})

test("HTTP derivation lets browser tasks run during computation, even with the library already loaded", async () => {
  await withCrypto(httpCrypto, async () => {
    await derivePasswordVerifier("warm up", "salt")
    let timer
    const browserTask = new Promise((resolve) => { timer = setTimeout(() => resolve("browser task"), 0) })
    const derivation = derivePasswordVerifier("synthetic-login-password", "synthetic-login-salt")
    try {
      assert.equal(await Promise.race([browserTask, derivation.then(() => "derivation finished")]), "browser task")
      assert.equal(await derivation, reference("synthetic-login-password", "synthetic-login-salt"))
    } finally {
      clearTimeout(timer)
      await derivation
    }
  })
})

test("concurrent HTTP derivations keep password and salt state isolated", async () => {
  await withCrypto(httpCrypto, async () => {
    const cases = vectors.slice(0, 3)
    const results = await Promise.all(cases.map(([password, salt]) => derivePasswordVerifier(password, salt)))
    assert.deepEqual(results, cases.map(([password, salt]) => reference(password, salt)))
  })
})

test("registration uses a fresh secure salt on HTTP and keeps existing explicit salts", async () => {
  await withCrypto(httpCrypto, async () => {
    const first = await createPasswordVerifier("synthetic registration password")
    const second = await createPasswordVerifier("synthetic registration password")
    for (const payload of [first, second]) {
      assert.match(payload.passwordSalt, /^[\w-]{22}$/)
      assert.equal(payload.passwordVerifier, reference("synthetic registration password", payload.passwordSalt))
    }
    assert.notEqual(first.passwordSalt, second.passwordSalt)
    assert.deepEqual(await createPasswordVerifier("password", "existing-salt"), {
      passwordSalt: "existing-salt",
      passwordVerifier: reference("password", "existing-salt"),
    })
  })
})

test("native derivation failures propagate without silently trying another crypto path", async () => {
  const failure = new Error("synthetic native derivation failure")
  await withCrypto({ ...httpCrypto, subtle: { importKey: async () => { throw failure } } }, async () => {
    await assert.rejects(derivePasswordVerifier("password", "salt"), (error) => error === failure)
  })
})

test("registration never substitutes insecure randomness when browser crypto is unavailable", async () => {
  await withCrypto(undefined, async () => {
    await assert.rejects(createPasswordVerifier("password"), /secure random values/)
  })
})
