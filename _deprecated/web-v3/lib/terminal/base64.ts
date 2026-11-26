// Terminal bytes travel as standard base64 (RFC 4648 §4) in both directions.
// Output is decoded to bytes (not text) so a UTF-8 sequence split across two chunks is reassembled by xterm.js.

const encoder = new TextEncoder()

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Keyboard / paste input as produced by xterm.js `onData` (a JS string) → UTF-8 → base64. */
export function textToBase64(text: string): string {
  return bytesToBase64(encoder.encode(text))
}

/** xterm.js `onBinary` strings carry one byte per char (legacy X10 mouse reports). */
export function binaryStringToBase64(binary: string): string {
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff
  return bytesToBase64(bytes)
}
