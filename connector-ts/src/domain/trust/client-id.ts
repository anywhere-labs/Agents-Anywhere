import { createHash } from 'node:crypto'

/** e2ee 1.0: every binding string is `aa-e2ee/1.0` plus its fields, NUL separated (contracts/e2ee/1.0/README.md). */
export const E2EE_LABEL = 'aa-e2ee/1.0'

export function e2eeLabel(...fields: readonly string[]): Buffer {
  for (const field of fields) {
    if (field.includes('\0')) throw new RangeError('binding fields must not contain NUL')
  }
  return Buffer.from([E2EE_LABEL, ...fields].join('\0'), 'utf8')
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Lower(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

export const CLIENT_ID_PATTERN = /^cli_[a-z2-7]{26}$/

/** `cli_` + lowercase base32(SHA-256(label('client-id') ‖ 0x00 ‖ identityPub))[:26]. */
export function clientIdFor(identityPub: Uint8Array): string {
  const digest = createHash('sha256').update(e2eeLabel('client-id')).update(Uint8Array.of(0)).update(identityPub).digest()
  return `cli_${base32Lower(digest).slice(0, 26)}`
}

/** What people compare out of band: the first 32 hex digits of SHA-256(pub), 8 groups of 4. */
export function identityFingerprint(identityPub: Uint8Array): string {
  const hex = createHash('sha256').update(identityPub).digest('hex').slice(0, 32)
  return hex.match(/.{4}/g)!.join(' ')
}
