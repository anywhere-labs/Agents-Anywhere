import { BridgeError } from './errors.js'
import type { InboundFrame, JsonRpcId } from './types.js'

/** Whether a value is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Require a non-empty string field from process-boundary input. */
export function stringField(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a non-empty string`, { retryable: false })
  }
  return candidate
}

/** Read an optional string field from process-boundary input. */
export function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'string') {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a string when present`, { retryable: false })
  }
  return candidate
}

/** Require an optional positive bounded integer field. */
export function limitField(value: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const candidate = value[key]
  if (candidate === undefined) return fallback
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0 || (candidate as number) > maximum) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a positive integer no greater than ${maximum}`, { retryable: false })
  }
  return candidate as number
}

/** Require a plain object field. */
export function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key]
  if (!isRecord(candidate)) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be an object`, { retryable: false })
  }
  return candidate
}

/** Require an array field. */
export function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key]
  if (!Array.isArray(candidate)) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be an array`, { retryable: false })
  }
  return candidate
}

/** Require a boolean field when present. */
export function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'boolean') {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a boolean when present`, { retryable: false })
  }
  return candidate
}

function validId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value))
}

/** Validate one decoded JSON value as a bridge v1 request or notification. */
export function validateInboundFrame(value: unknown): InboundFrame {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length === 0) {
    throw new BridgeError('INVALID_REQUEST', 'Expected a JSON-RPC 2.0 request or notification.', { retryable: false })
  }
  const params = value.params ?? {}
  if (!isRecord(params)) {
    throw new BridgeError('INVALID_PARAMS', 'params must be an object when present.', { retryable: false })
  }
  if (!Object.hasOwn(value, 'id')) return { jsonrpc: '2.0', method: value.method, params }
  if (!validId(value.id)) {
    throw new BridgeError('INVALID_REQUEST', 'id must be a non-empty string or safe integer.', { retryable: false })
  }
  return { jsonrpc: '2.0', id: value.id, method: value.method, params }
}
