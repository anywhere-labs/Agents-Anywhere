import { createHash } from 'node:crypto'
import type { Json, TimelineItem } from './types.js'

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function sessionId(namespace: string, externalId: string): string {
  const prefix = `aa_${digest(namespace).slice(0, 16)}_`
  if (externalId.startsWith(prefix) && /^[\w-]{1,128}$/.test(externalId.slice(prefix.length))) return externalId.slice(prefix.length)
  return `sess_dsh_${digest(`${namespace}:dsh:${externalId}`).slice(0, 24)}`
}

export function nativeSessionId(namespace: string, platformId: string): string {
  if (!/^[\w-]{1,128}$/.test(platformId)) throw new Error('Invalid platform session identity')
  return `aa_${digest(namespace).slice(0, 16)}_${platformId}`
}

export function itemId(externalId: string, kind: string, businessId: string): string {
  return `dsh_${digest(`${externalId}\0${kind}\0${businessId}`)}`
}

export function userMessageId(externalId: string, clientId: string): string {
  return `aa.${digest(externalId).slice(0, 16)}.${Buffer.from(clientId).toString('base64url')}`
}

export function clientMessageId(externalId: string, nativeId: string): string | undefined {
  const prefix = `aa.${digest(externalId).slice(0, 16)}.`
  if (!nativeId.startsWith(prefix)) return
  const value = Buffer.from(nativeId.slice(prefix.length), 'base64url').toString('utf8')
  if (value && userMessageId(externalId, value) === nativeId) return value
}

// Match Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':'))
// after JSON transport, including float exponents and Unicode object-key ordering.
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => {
      const aa = Array.from(a, c => c.codePointAt(0)!)
      const bb = Array.from(b, c => c.codePointAt(0)!)
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
        if (aa[i] !== bb[i]) return aa[i]! - bb[i]!
      }
      return aa.length - bb.length
    })
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(',')}}`
  }
  if (typeof value === 'number') {
    let text = JSON.stringify(value)
    if (text.includes('.') && Math.abs(value) < 0.0001 && value !== 0) text = value.toExponential()
    return text.replace(/e([+-]?)(\d+)$/, (_, sign: string, exponent: string) =>
      `e${sign || '+'}${exponent.padStart(2, '0')}`)
  }
  return JSON.stringify(value)
}

export function contentHash(item: Pick<TimelineItem, 'type' | 'status' | 'role' | 'content'>): string {
  return `sha256:${digest(canonicalJson({ type: item.type, status: item.status, role: item.role, content: item.content }))}`
}
