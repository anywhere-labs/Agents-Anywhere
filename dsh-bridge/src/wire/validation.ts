import { BridgeError } from './errors.js'
import {
  INBOUND_NOTIFICATION_METHODS,
  REQUEST_METHODS,
  type InboundNotificationMethod,
  type RequestMethod,
} from './protocol.js'
import type { InboundFrame, JsonRpcId } from './types.js'

const REQUEST_SET = new Set<string>(REQUEST_METHODS)
const NOTIFICATION_SET = new Set<string>(INBOUND_NOTIFICATION_METHODS)
const REQUEST_KEYS = new Set(['jsonrpc', 'id', 'method', 'params'])
const NOTIFICATION_KEYS = new Set(['jsonrpc', 'method', 'params'])

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function validateInboundFrame(value: unknown): InboundFrame {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new BridgeError('INVALID_REQUEST', 'Expected a JSON-RPC 2.0 object.', { retryable: false })
  }
  if (typeof value.method !== 'string' || !isRecord(value.params)) {
    throw new BridgeError('INVALID_REQUEST', 'method and params are required.', { retryable: false })
  }
  if (Object.hasOwn(value, 'id')) {
    assertOnlyKeys(value, REQUEST_KEYS)
    if (!validId(value.id)) {
      throw new BridgeError('INVALID_REQUEST', 'id must be a non-empty string or safe integer.', { retryable: false })
    }
    if (!REQUEST_SET.has(value.method)) {
      throw new BridgeError('METHOD_NOT_FOUND', `Unknown bridge method: ${value.method}`, { retryable: false })
    }
    return {
      jsonrpc: '2.0',
      id: value.id,
      method: value.method as RequestMethod,
      params: value.params,
    }
  }
  assertOnlyKeys(value, NOTIFICATION_KEYS)
  if (!NOTIFICATION_SET.has(value.method)) {
    throw new BridgeError('METHOD_NOT_FOUND', `Unknown bridge notification: ${value.method}`, { retryable: false })
  }
  return {
    jsonrpc: '2.0',
    method: value.method as InboundNotificationMethod,
    params: value.params,
  }
}

export function stringField(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a non-empty string.`, { retryable: false })
  }
  return candidate
}

export function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'string') {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a string when present.`, { retryable: false })
  }
  return candidate
}

export function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key]
  if (!isRecord(candidate)) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be an object.`, { retryable: false })
  }
  return candidate
}

export function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key]
  if (!Array.isArray(candidate)) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be an array.`, { retryable: false })
  }
  return candidate
}

export function limitField(value: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const candidate = value[key]
  if (candidate === undefined) return fallback
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0 || (candidate as number) > maximum) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be between 1 and ${maximum}.`, { retryable: false })
  }
  return candidate as number
}

function validId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value))
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new BridgeError('INVALID_REQUEST', 'JSON-RPC frame has unknown fields.', { retryable: false })
  }
}
