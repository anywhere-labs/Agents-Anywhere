import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

/**
 * Byte, base64 and hashing helpers.
 *
 * The Android client gets these from `java.util.Base64`, `java.security.
 * SecureRandom` and `MessageDigest`. HarmonyOS splits them across
 * `@kit.ArkTS`'s `util.Base64Helper` and `@kit.CryptoArchitectureKit`, so they
 * are funnelled through one module to keep call sites readable.
 *
 * Every call into those kits is reported by the ArkTS linter as "may throw
 * exceptions", so each one is wrapped and re-thrown with context. A failure here
 * is always fatal to the operation that needed the bytes, so the message matters
 * more than the recovery.
 */

const base64Helper: util.Base64Helper = new util.Base64Helper();

function wrapFailure(operation: string, error: Object): Error {
  const detail: string = error instanceof Error ? error.message : JSON.stringify(error);
  return new Error(`${operation} failed: ${detail}`);
}

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Uint8Array {
  try {
    const random: cryptoFramework.Random = cryptoFramework.createRandom();
    const blob: cryptoFramework.DataBlob = random.generateRandomSync(length);
    return blob.data;
  } catch (error) {
    throw wrapFailure(`Generating ${length} random bytes`, error);
  }
}

/**
 * Base64url without padding, the encoding PKCE requires for both the verifier
 * and the S256 challenge.
 */
export function base64UrlNoPadding(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Standard base64 with padding. */
export function base64Encode(bytes: Uint8Array): string {
  try {
    return base64Helper.encodeToStringSync(bytes);
  } catch (error) {
    throw wrapFailure('Encoding base64', error);
  }
}

/** Decodes standard base64. Throws when the input is not valid base64. */
export function base64Decode(text: string): Uint8Array {
  try {
    return base64Helper.decodeSync(text);
  } catch (error) {
    throw wrapFailure('Decoding base64', error);
  }
}

/** SHA-256 digest of the given bytes. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
    const input: cryptoFramework.DataBlob = { data: bytes };
    await md.update(input);
    const digest: cryptoFramework.DataBlob = await md.digest();
    return digest.data;
  } catch (error) {
    throw wrapFailure('Computing SHA-256', error);
  }
}

/** Lowercase hex, used for the attachment SHA-256 comparison. */
export function toHex(bytes: Uint8Array): string {
  let out: string = '';
  for (let index = 0; index < bytes.length; index++) {
    out += bytes[index].toString(16).padStart(2, '0');
  }
  return out;
}

/** A fresh RFC 4122 version 4 UUID, used for idempotency keys. */
export function randomUuid(): string {
  try {
    return util.generateRandomUUID(true);
  } catch (error) {
    throw wrapFailure('Generating a UUID', error);
  }
}
