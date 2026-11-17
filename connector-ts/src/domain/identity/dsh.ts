import { IdentityInputError } from './errors.js'
import { sha256Hex, sha256HexLenient } from './hash.js'

/** connector/runtimes/dsh/identity.py `timeline_item_id` (rejects empty components). */
export function dshTimelineItemId(externalSessionId: string, projectionKind: string, businessId: string): string {
  if (!externalSessionId || !projectionKind || !businessId) {
    throw new IdentityInputError('timeline identity components must not be empty')
  }
  return `dsh_${sha256Hex(`${externalSessionId}\0${projectionKind}\0${businessId}`)}`
}

// ---------------------------------------------------------------------------
// DSH plugin algorithms (dsh-bridge-next/src/host/dsh-runtime/identity.ts). The plugin computes them in Node,
// so they keep Node's lenient UTF-8 (lone surrogates hash as U+FFFD) and accept empty inputs.
// ---------------------------------------------------------------------------

const PLATFORM_ID = /^[\w-]{1,128}$/

function namespacePrefix(namespace: string): string {
  return `aa_${sha256HexLenient(namespace).slice(0, 16)}_`
}

/** Platform session id of a DSH session; AA-created sessions carry their platform id in the native id. */
export function dshPluginSessionId(namespace: string, externalSessionId: string): string {
  const prefix = namespacePrefix(namespace)
  if (externalSessionId.startsWith(prefix) && PLATFORM_ID.test(externalSessionId.slice(prefix.length))) {
    return externalSessionId.slice(prefix.length)
  }
  return `sess_dsh_${sha256HexLenient(`${namespace}:dsh:${externalSessionId}`).slice(0, 24)}`
}

/** Native DSH session id the plugin assigns to a session created from AA. */
export function dshPluginNativeSessionId(namespace: string, platformSessionId: string): string {
  if (!PLATFORM_ID.test(platformSessionId)) throw new IdentityInputError('Invalid platform session identity')
  return `${namespacePrefix(namespace)}${platformSessionId}`
}

export function dshPluginItemId(externalSessionId: string, kind: string, businessId: string): string {
  return `dsh_${sha256HexLenient(`${externalSessionId}\0${kind}\0${businessId}`)}`
}

function messagePrefix(externalSessionId: string): string {
  return `aa.${sha256HexLenient(externalSessionId).slice(0, 16)}.`
}

/** Native user-message id that carries an AA client message id (continue messages use `continue:{endSeq}`). */
export function dshPluginUserMessageId(externalSessionId: string, clientMessageId: string): string {
  return `${messagePrefix(externalSessionId)}${Buffer.from(clientMessageId, 'utf8').toString('base64url')}`
}

/** Inverse of dshPluginUserMessageId; null unless re-encoding reproduces the native id exactly. */
export function dshPluginClientMessageId(externalSessionId: string, nativeMessageId: string): string | null {
  const prefix = messagePrefix(externalSessionId)
  if (!nativeMessageId.startsWith(prefix)) return null
  const value = Buffer.from(nativeMessageId.slice(prefix.length), 'base64url').toString('utf8')
  return value && dshPluginUserMessageId(externalSessionId, value) === nativeMessageId ? value : null
}
