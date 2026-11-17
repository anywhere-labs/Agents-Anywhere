import { IdentityInputError } from './errors.js'
import type { JsonValue } from './python-json.js'

export type JsonObject = { readonly [key: string]: JsonValue }

/** Python `dict.get(key)` on parsed JSON: missing keys are None (null). */
export function pyGet(object: JsonObject, key: string): JsonValue {
  return Object.hasOwn(object, key) ? (object[key] as JsonValue) : null
}

/** Python truthiness of a JSON value. */
export function pyTruthy(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return Object.keys(value).length > 0
}

/** Python `a or b or c`: the first truthy value, else the last one. */
export function pyOr(...values: JsonValue[]): JsonValue {
  for (const value of values) if (pyTruthy(value)) return value
  return values.length ? (values[values.length - 1] as JsonValue) : null
}

/** Python `str()` for the scalar JSON values the identity rules stringify. */
export function pyStr(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value === null) return 'None'
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1e21) return value.toFixed(0)
  throw new IdentityInputError('str() of this value is not reproduced')
}

export function isNonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}
