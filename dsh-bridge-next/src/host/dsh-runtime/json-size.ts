/** Measure JSON payloads without allocating a serialized copy. Payloads are plain JSON. */
export function jsonBytes(value: unknown): number {
  const seen = new Set<object>()
  function stringBytes(text: string): number {
    let bytes = Buffer.byteLength(text) + 2
    // JSON escapes controls, quotes, backslashes and lone UTF-16 surrogates.
    const escapes = /[\u0000-\u001f"\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
    for (const match of text.matchAll(escapes)) {
      const char = match[0]
      bytes += ['"', '\\', '\b', '\f', '\n', '\r', '\t'].includes(char) ? 1
        : char.charCodeAt(0) < 32 ? 5 : 3
    }
    return bytes
  }
  function size(input: unknown): number {
    if (input === null || input === undefined) return 4
    if (typeof input === 'string') return stringBytes(input)
    if (typeof input === 'boolean') return input ? 4 : 5
    if (typeof input === 'number') return Number.isFinite(input) ? String(Object.is(input, -0) ? 0 : input).length : 4
    if (typeof input !== 'object') throw new TypeError('Expected JSON data')
    if (seen.has(input)) throw new TypeError('Cyclic JSON data')
    seen.add(input)
    let bytes = 2, count = 0
    if (Array.isArray(input)) {
      for (const entry of input) { bytes += size(entry); count++ }
    } else {
      for (const [key, entry] of Object.entries(input)) {
        if (entry === undefined) continue
        bytes += stringBytes(key) + 1 + size(entry); count++
      }
    }
    seen.delete(input)
    return bytes + Math.max(0, count - 1)
  }
  return size(value)
}
