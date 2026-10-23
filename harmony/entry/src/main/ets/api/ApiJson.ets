import { AAResponseFormatError } from './ApiError';

/**
 * Tolerant JSON field readers.
 *
 * Ported from `ApiJson.kt` and the parsing helpers in `ApiClient.kt`.
 *
 * The Server contract treats a missing field, a JSON null and an empty string as
 * the same thing for every optional string: all of them collapse to `null`.
 * Reproducing that here is what lets the DTO interfaces be declared with every
 * field optional without scattering `??` expressions through the mappers.
 *
 * DTO interfaces in this package therefore declare every field optional and are
 * produced by a plain `as` cast over `JSON.parse`. A field that the Server
 * omitted simply reads as `undefined` at runtime and is normalised below.
 */

/** Absent, null or blank becomes `null`; anything else is returned as-is. */
export function optionalString(value: string | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value.length > 0 ? value : null;
}

export function stringOr(value: string | undefined, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value;
}

/** Mirrors Kotlin's `optString(name, default)` combined with a blank check. */
export function stringOrFallbackWhenBlank(value: string | undefined, fallback: string): string {
  if (value === undefined || value === null || value.length === 0) {
    return fallback;
  }
  return value;
}

export function optionalNumber(value: number | undefined): number | null {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return null;
  }
  return value;
}

export function numberOr(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return fallback;
  }
  return value;
}

export function optionalBoolean(value: boolean | undefined): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value;
}

export function booleanOr(value: boolean | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value;
}

/**
 * Reads a field the Server must always send. Android used `getString`, which
 * throws, so the same strictness is kept here: a silently defaulted required
 * field would hide a real contract break.
 */
export function requireString(value: string | undefined, fieldName: string): string {
  if (value === undefined || value === null) {
    throw new AAResponseFormatError(`The server response is missing "${fieldName}".`);
  }
  return value;
}

export function requireNumber(value: number | undefined, fieldName: string): number {
  if (value === undefined || value === null || Number.isNaN(value)) {
    throw new AAResponseFormatError(`The server response is missing "${fieldName}".`);
  }
  return value;
}

/** Parses a JSON document into an object, or throws the shared format error. */
export function parseJsonObject(text: string): Object {
  if (text.trim().length === 0) {
    // ArkTS rejects an untyped `{}` literal, and a blank body is a legitimate
    // empty JSON object on this API (several endpoints reply 204-style).
    return JSON.parse('{}') as Object;
  }
  try {
    return JSON.parse(text) as Object;
  } catch (error) {
    const message: string = error instanceof Error ? error.message : 'unknown';
    throw new AAResponseFormatError(`The server returned an invalid response (${message}).`);
  }
}

/** Parses a JSON array document, used by the bulk session endpoints. */
export function parseJsonArray(text: string): Object[] {
  try {
    return JSON.parse(text) as Object[];
  } catch (error) {
    const message: string = error instanceof Error ? error.message : 'unknown';
    throw new AAResponseFormatError(`The server returned an invalid response (${message}).`);
  }
}

/** Reads a nested object field, or `undefined` when it is absent or not an object. */
export function objectField(value: Object | undefined): Object | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return undefined;
}

/** Reads a nested array field, or an empty array when it is absent or not an array. */
export function arrayField(value: Object | undefined): Object[] {
  if (value === undefined || value === null || !Array.isArray(value)) {
    return [];
  }
  return value as Object[];
}
