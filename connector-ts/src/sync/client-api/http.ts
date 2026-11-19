import type { TunnelApiRequest, TunnelApiResponse } from '../../application/inbound/tunnel-api.js'

/** A client API error: FastAPI's `{detail: {code, message}}`, which the clients already parse. */
export class TunnelHttpError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'TunnelHttpError'
  }
}

export const notFound = (what: string): TunnelHttpError => new TunnelHttpError(404, 'not_found', what)
export const invalid = (message: string): TunnelHttpError => new TunnelHttpError(422, 'invalid_argument', message)
/** A conflict with the session's state (read-only, not running, capability missing): 409. */
export const conflict = (code: string, message: string): TunnelHttpError => new TunnelHttpError(409, code, message)

/** AA error codes and the HTTP status a client gets for them by default. */
export function statusOf(code: string): number {
  switch (code) {
    case 'session_not_found':
    case 'not_found':
    case 'terminal_not_found':
    case 'file_not_found':
    case 'plan_document_not_found':
    case 'queue_item_not_found':
      return 404
    case 'invalid_argument':
    case 'invalid_path':
      return 422
    case 'path_not_allowed':
    case 'permission_denied':
      return 403
    case 'precondition_failed':
    case 'if_match_failed':
      return 412
    case 'runtime_unavailable':
      return 503
    default:
      return 409
  }
}

/** The code and message of any error (a use case's, the workspace's, or a rejected command's). */
export function codeOf(error: unknown): { code: string; message: string } {
  if (error instanceof TunnelHttpError) return { code: error.code, message: error.message }
  const code = (error as { code?: unknown })?.code
  const message = (error as Error)?.message ?? String(error)
  return { code: typeof code === 'string' ? code : 'internal', message }
}

/** Runs `work`; any coded error it throws becomes a `TunnelHttpError` with `status`, unless `keep` lists its code. */
export async function withStatus<T>(status: number, work: () => Promise<T>, keep: Readonly<Record<string, number>> = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof TunnelHttpError) throw error
    const { code, message } = codeOf(error)
    if (code === 'internal') throw error
    throw new TunnelHttpError(keep[code] ?? status, code, message)
  }
}

export function errorBody(error: unknown): TunnelApiResponse {
  if (error instanceof TunnelHttpError) return { status: error.status, body: { detail: { code: error.code, message: error.message, ...error.extra } } }
  const { code, message } = codeOf(error)
  if (code !== 'internal') return { status: statusOf(code), body: { detail: { code, message } } }
  return { status: 500, body: { detail: { code: 'internal', message } } }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function int(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw invalid(`expected an integer in [${min}, ${max}]`)
  return parsed
}

/** `RpcResponsePayload` of a success: `{ok: true, result, error: null}`. */
export function okBody(result: unknown): TunnelApiResponse {
  return { status: 200, body: { ok: true, result: result ?? null, error: null } }
}

export interface Route {
  readonly method: string
  readonly segments: readonly string[]
  readonly query: URLSearchParams
  readonly body: Record<string, unknown>
  /** The body as sent, when it is not an object (a JSON array or a scalar). */
  readonly rawBody: unknown
}

/** `/api/v2/sessions/x/snapshot?limit=5` → segments `['sessions', 'x', 'snapshot']` (the namespace is optional). */
export function parse(request: TunnelApiRequest): Route {
  const url = new URL(request.path, 'http://device.invalid')
  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  if (segments[0] === 'api' && /^v\d+$/u.test(segments[1] ?? '')) segments.splice(0, 2)
  return { method: request.method, segments, query: url.searchParams, body: record(request.body), rawBody: request.body }
}

/** A base64 slice also receives MeshCall's encrypted envelope inside a 4 MiB frame. */
export const CONTENT_CHUNK_BYTES = 2 * 1024 * 1024
