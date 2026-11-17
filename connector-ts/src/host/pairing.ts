/** A JSON request through the Connector's network egress (wired by entry/ to link's `requestJson`). */
export type FetchJson = (method: 'GET' | 'POST', url: string, body?: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>

/** An HTTP failure with its status, as `FetchJson` reports it. */
export interface HttpFailure {
  readonly status: number
}

function isHttpFailure(error: unknown): error is HttpFailure {
  return typeof (error as { status?: unknown })?.status === 'number'
}

/**
 * The Server URL a user typed: a full http(s) URL is taken as is; a bare host is
 * tried over https, then http, against `/api/v2/health` (anything below 500 counts as reachable).
 */
export async function resolvePairServerUrl(value: string | null | undefined, fetchJson: FetchJson, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
  const normalized = (value ?? '').trim().replace(/\/+$/u, '')
  if (normalized === '') throw Object.assign(new Error('server is required'), { code: 'invalid_argument' })
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(normalized)?.[1]?.toLowerCase()
  if (scheme !== undefined) {
    if (scheme === 'http' || scheme === 'https') return normalized
    throw Object.assign(new Error('server URL must use http or https'), { code: 'invalid_argument' })
  }
  const errors: string[] = []
  for (const candidate of [`https://${normalized}`, `http://${normalized}`]) {
    try {
      await fetchJson('GET', `${candidate}/api/v2/health`, undefined, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
      return candidate
    } catch (error) {
      if (isHttpFailure(error) && error.status < 500) return candidate
      errors.push(`${candidate}: ${(error as Error).message}`)
    }
  }
  throw new Error(`could not reach server over https or http (${errors.join('; ')})`)
}

export interface PairingStart {
  readonly pairingId: string
  readonly code: string
}

export async function startPairing(fetchJson: FetchJson, serverUrl: string, ttlSeconds: number, signal?: AbortSignal): Promise<PairingStart> {
  const payload = await fetchJson('POST', `${serverUrl}/api/v2/pairing/start`, { serverUrl, ttlSeconds: Math.trunc(ttlSeconds) }, signal !== undefined ? { signal } : {}) as Record<string, unknown> | null
  if (payload === null || typeof payload !== 'object' || typeof payload.pairingId !== 'string') throw new Error('pairing start response must be an object with pairingId')
  return { pairingId: payload.pairingId, code: String(payload.code ?? '') }
}

export async function pollPairing(fetchJson: FetchJson, serverUrl: string, pairingId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const payload = await fetchJson('POST', `${serverUrl}/api/v2/pairing/poll`, { pairingId }, signal !== undefined ? { signal } : {})
  if (payload === null || typeof payload !== 'object') throw new Error('pairing poll response must be an object')
  return payload as Record<string, unknown>
}
