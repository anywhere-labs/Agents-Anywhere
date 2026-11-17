import { createHash } from 'node:crypto'
import { IdentityInputError } from './errors.js'

/** Python `str.encode('utf-8')`: lone surrogates raise instead of becoming U+FFFD. */
export function utf8Strict(text: string): Buffer {
  if (!text.isWellFormed()) throw new IdentityInputError('text contains a lone surrogate (Python UnicodeEncodeError)')
  return Buffer.from(text, 'utf8')
}

/** sha256 hex of the strict UTF-8 encoding (v2 Python helpers). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(utf8Strict(text)).digest('hex')
}

export function sha256Bytes(text: string): Buffer {
  return createHash('sha256').update(utf8Strict(text)).digest()
}

/** sha256 hex as Node computes it for JS strings (the DSH plugin): lone surrogates become U+FFFD. */
export function sha256HexLenient(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Python `base64.urlsafe_b64encode(...).rstrip('=')`. */
export function base64UrlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Python `base64.urlsafe_b64encode(...)` with its '=' padding kept. */
export function base64UrlPadded(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('base64url')
  return text + '='.repeat((4 - (text.length % 4)) % 4)
}
