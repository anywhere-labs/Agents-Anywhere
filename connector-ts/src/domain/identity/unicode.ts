/**
 * Python `str` predicates the v2 identity rules depend on. Python resolves them against its bundled
 * Unicode database, so code points assigned only in a newer Unicode version than the v2 interpreter
 * knew may disagree; the golden vectors pin the common cases.
 */

/** Python `str.isalnum()` for one code point: general category L* or N*. */
export function pythonIsAlnum(char: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(char)
}

/** Python `unicodedata.category(c) in {'Cc', 'Cf', 'Cs'}` over the whole string. */
export function containsControlCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
}

/** Python `str.isspace()` for strings that already passed `containsControlCharacter`. */
export function isBlank(value: string): boolean {
  return value.trim() === ''
}

/**
 * Python `str.casefold()` (Unicode full case folding, no Turkic rules), code point by code point.
 * Full folding equals lower(upper(c)) except for the entries handled explicitly below.
 */
export function pythonCasefold(text: string): string {
  let result = ''
  for (const char of text) result += foldCodePoint(char)
  return result
}

function foldCodePoint(char: string): string {
  const code = char.codePointAt(0) as number
  if (code === 0x0131) return char // dotless i has no folding
  if (code === 0x1e9e) return 'ss' // capital sharp s folds like ß
  // Cherokee folds to the uppercase block (CaseFolding.txt), the opposite of lowercasing.
  if (code >= 0x13a0 && code <= 0x13f5) return char
  if (code >= 0x13f8 && code <= 0x13fd) return String.fromCodePoint(code - 8)
  if (code >= 0xab70 && code <= 0xabbf) return String.fromCodePoint(code - 0xab70 + 0x13a0)
  return char.toUpperCase().toLowerCase()
}

export function nfc(text: string): string {
  return text.normalize('NFC')
}
