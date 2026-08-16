import { createHash } from 'node:crypto'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function modelSelectionId(provider: string, model: string, reasoning: string | null = null): string {
  return `dsh:model:${b64url([provider, model, reasoning])}`
}

export function decodeModelSelection(value: string): { provider: string; model: string; reasoning: string | null } {
  if (!value.startsWith('dsh:model:')) throw new Error('invalid DSH model selection')
  const decoded: unknown = JSON.parse(Buffer.from(value.slice(10), 'base64url').toString('utf8'))
  if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string' || (decoded[2] !== null && typeof decoded[2] !== 'string')) {
    throw new Error('invalid DSH model selection')
  }
  return { provider: decoded[0], model: decoded[1], reasoning: decoded[2] }
}

export function permissionSelectionId(name: string): string {
  return `dsh:permission:${Buffer.from(name, 'utf8').toString('base64url')}`
}

export function decodePermissionSelection(value: string): string {
  if (!value.startsWith('dsh:permission:')) throw new Error('invalid DSH permission selection')
  const name = Buffer.from(value.slice(15), 'base64url').toString('utf8')
  if (!name) throw new Error('invalid DSH permission selection')
  return name
}

export function timelineId(externalSessionId: string, projectionKind: string, businessId: string): string {
  return `dsh_${createHash('sha256').update(`${externalSessionId}\0${projectionKind}\0${businessId}`).digest('hex')}`
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export function contentHash(type: string, status: string, role: string | null, content: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalJson({ type, status, role, content })).digest('hex')}`
}
