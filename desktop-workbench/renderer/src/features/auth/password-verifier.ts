const PBKDF2_ITERATIONS = 120_000;
const VERIFIER_BYTES = 32;

export type PasswordVerifierPayload = {
  passwordVerifier: string;
  passwordSalt: string;
};

export async function createPasswordVerifier(
  password: string,
  salt = randomSalt(),
): Promise<PasswordVerifierPayload> {
  return {
    passwordVerifier: await derivePasswordVerifier(password, salt),
    passwordSalt: salt
  };
}

export async function derivePasswordVerifier(
  password: string,
  salt: string,
): Promise<string> {
  const passwordBytes = new TextEncoder().encode(password);
  const saltBytes = new TextEncoder().encode(salt);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const key = await subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: saltBytes,
        iterations: PBKDF2_ITERATIONS
      },
      key,
      VERIFIER_BYTES * 8,
    );
    return base64Url(new Uint8Array(bits));
  }
  return base64Url(
    pbkdf2Sha256(passwordBytes, saltBytes, PBKDF2_ITERATIONS, VERIFIER_BYTES),
  );
}

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  getCrypto().getRandomValues(bytes);
  return base64Url(bytes);
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This browser does not support secure random values.");
  }
  return globalThis.crypto;
}

function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number,
): Uint8Array {
  const blockCount = Math.ceil(keyLength / 32);
  const output = new Uint8Array(blockCount * 32);
  for (let block = 1; block <= blockCount; block += 1) {
    const blockSalt = new Uint8Array(salt.length + 4);
    blockSalt.set(salt);
    blockSalt[salt.length] = (block >>> 24) & 0xff;
    blockSalt[salt.length + 1] = (block >>> 16) & 0xff;
    blockSalt[salt.length + 2] = (block >>> 8) & 0xff;
    blockSalt[salt.length + 3] = block & 0xff;

    let u = hmacSha256(password, blockSalt);
    const t = new Uint8Array(u);
    for (let i = 1; i < iterations; i += 1) {
      u = hmacSha256(password, u);
      for (let j = 0; j < t.length; j += 1) t[j] = byte(t, j) ^ byte(u, j);
    }
    output.set(t, (block - 1) * 32);
  }
  return output.slice(0, keyLength);
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let normalizedKey = key;
  if (normalizedKey.length > 64) normalizedKey = sha256(normalizedKey);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i += 1) {
    const byte = normalizedKey[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

function sha256(message: Uint8Array): Uint8Array {
  const initialHash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const padded = new Uint8Array((((message.length + 9 + 63) / 64) | 0) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const bitLength = message.length * 8;
  for (let i = 0; i < 8; i += 1) {
    padded[padded.length - 1 - i] = (bitLength / 2 ** (8 * i)) & 0xff;
  }

  const words = new Uint32Array(64);
  const hash = new Uint32Array(initialHash);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      words[i] =
        (byte(padded, j) << 24) |
        (byte(padded, j + 1) << 16) |
        (byte(padded, j + 2) << 8) |
        byte(padded, j + 3);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = word(words, i - 15);
      const w2 = word(words, i - 2);
      const s0 =
        rotateRight(w15, 7) ^
        rotateRight(w15, 18) ^
        (w15 >>> 3);
      const s1 =
        rotateRight(w2, 17) ^
        rotateRight(w2, 19) ^
        (w2 >>> 10);
      words[i] = (word(words, i - 16) + s0 + word(words, i - 7) + s1) >>> 0;
    }

    let a = word(hash, 0);
    let b = word(hash, 1);
    let c = word(hash, 2);
    let d = word(hash, 3);
    let e = word(hash, 4);
    let f = word(hash, 5);
    let g = word(hash, 6);
    let h = word(hash, 7);
    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + word(constants, i) + word(words, i)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (word(hash, 0) + a) >>> 0;
    hash[1] = (word(hash, 1) + b) >>> 0;
    hash[2] = (word(hash, 2) + c) >>> 0;
    hash[3] = (word(hash, 3) + d) >>> 0;
    hash[4] = (word(hash, 4) + e) >>> 0;
    hash[5] = (word(hash, 5) + f) >>> 0;
    hash[6] = (word(hash, 6) + g) >>> 0;
    hash[7] = (word(hash, 7) + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  for (let i = 0; i < hash.length; i += 1) {
    const value = word(hash, i);
    digest[i * 4] = value >>> 24;
    digest[i * 4 + 1] = value >>> 16;
    digest[i * 4 + 2] = value >>> 8;
    digest[i * 4 + 3] = value;
  }
  return digest;
}

function byte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function word(words: Uint32Array, index: number): number {
  return words[index] ?? 0;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
