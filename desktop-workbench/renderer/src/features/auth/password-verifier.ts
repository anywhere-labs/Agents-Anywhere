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
  try {
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

    // Non-secure HTTP origins cannot use SubtleCrypto. Load the JS implementation
    // only there, and yield to the browser between short batches so native OAuth
    // login pages can keep rendering and responding while deriving the verifier.
    const [{ pbkdf2Async }, { sha256 }] = await Promise.all([
      import("@noble/hashes/pbkdf2.js"),
      import("@noble/hashes/sha2.js"),
    ]);
    const bytes = await pbkdf2Async(sha256, passwordBytes, saltBytes, {
      c: PBKDF2_ITERATIONS,
      dkLen: VERIFIER_BYTES,
      asyncTick: 10,
    });
    return base64Url(bytes);
  } finally {
    passwordBytes.fill(0);
  }
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
