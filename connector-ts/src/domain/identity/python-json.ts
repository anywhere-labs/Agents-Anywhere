import { IdentityInputError } from './errors.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface PythonJsonOptions {
  /** `sort_keys=True`: keys ordered by Unicode code point, as Python compares `str`. */
  readonly sortKeys: boolean
  /** `ensure_ascii`: escape every non-ASCII UTF-16 unit (and DEL) as lowercase `\uXXXX`. */
  readonly ensureAscii: boolean
  /** `allow_nan`; JSON input never carries NaN/Infinity, so this only selects the failure mode. */
  readonly allowNan?: boolean
}

/**
 * `json.dumps(value, separators=(',', ':'), ...)` byte-for-byte for values that went through JSON.
 *
 * Numbers follow what Python sees after parsing JSON written by a JavaScript peer: an integral value
 * below 1e21 is a Python `int` (plain digits); anything else is a `float` printed with `repr()`
 * (exponent form below 1e-4 or from 1e16, e.g. `1e-05`, `1e+21`). A Python float such as `1.0`
 * has no JavaScript counterpart and cannot be reproduced.
 */
export function pythonJsonDumps(value: JsonValue, options: PythonJsonOptions): string {
  return encode(value, options)
}

function encode(value: JsonValue, options: PythonJsonOptions): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return pythonNumber(value, options.allowNan ?? false)
  if (typeof value === 'string') return pythonString(value, options.ensureAscii)
  if (Array.isArray(value)) return `[${value.map(item => encode(item, options)).join(',')}]`
  const keys = Object.keys(value)
  if (options.sortKeys) keys.sort(compareCodePoints)
  return `{${keys.map(key => `${pythonString(key, options.ensureAscii)}:${encode(value[key] as JsonValue, options)}`).join(',')}}`
}

/** Python `str` ordering: by code point, not by UTF-16 unit as `Array.prototype.sort` does. */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0) as number)
  const b = Array.from(right, char => char.codePointAt(0) as number)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const difference = (a[index] as number) - (b[index] as number)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

export function pythonNumber(value: number, allowNan = false): string {
  if (!Number.isFinite(value)) {
    if (!allowNan) throw new IdentityInputError('out of range float values are not JSON compliant')
    return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    // A JavaScript integral number (including -0) reaches Python as an int.
    return Object.is(value, -0) ? '0' : value.toFixed(0)
  }
  return pythonFloatRepr(value)
}

/** CPython `float.__repr__` (shortest round-trip digits, exponent when exp < -4 or exp >= 16). */
export function pythonFloatRepr(value: number): string {
  if (Object.is(value, -0)) return '-0.0'
  if (value === 0) return '0.0'
  const exponential = value.toExponential()
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential)
  if (!match) throw new Error(`unexpected exponential form ${exponential}`)
  const [, sign, first, rest = '', exponentText] = match
  const exponent = Number(exponentText)
  const digits = `${first}${rest}`
  if (exponent < -4 || exponent >= 16) {
    const mantissa = rest ? `${first}.${rest}` : `${first}`
    const magnitude = String(Math.abs(exponent)).padStart(2, '0')
    return `${sign}${mantissa}e${exponent < 0 ? '-' : '+'}${magnitude}`
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  const integerLength = exponent + 1
  if (digits.length <= integerLength) return `${sign}${digits}${'0'.repeat(integerLength - digits.length)}.0`
  return `${sign}${digits.slice(0, integerLength)}.${digits.slice(integerLength)}`
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
}

/** Python `json.encoder.(py_)encode_basestring[_ascii]`. Lone surrogates pass through unescaped when !ensureAscii. */
export function pythonString(value: string, ensureAscii: boolean): string {
  let result = '"'
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string
    const unit = value.charCodeAt(index)
    const short = SHORT_ESCAPES[char]
    if (short !== undefined) result += short
    else if (unit < 0x20 || (ensureAscii && unit > 0x7e)) result += `\\u${unit.toString(16).padStart(4, '0')}`
    else result += char
  }
  return `${result}"`
}
