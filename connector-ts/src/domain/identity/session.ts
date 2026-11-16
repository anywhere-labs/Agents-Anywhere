import { IdentityInputError } from './errors.js'
import { sha256Hex } from './hash.js'
import { pythonJsonDumps, type JsonValue } from './python-json.js'
import { containsControlCharacter, isBlank, nfc, pythonCasefold } from './unicode.js'

/**
 * `sess_{runtime}_{sha256(connectorId:runtime:externalSessionId)[:24]}`
 * (connector/runtimes/session_identity.py). The colon join is not injective: callers must not rely
 * on components being colon-free.
 */
export function stableRuntimeSessionId(connectorId: string, runtime: string, externalSessionId: string): string {
  if (!connectorId) throw new IdentityInputError('connector_id must not be empty')
  if (!runtime) throw new IdentityInputError('runtime must not be empty')
  if (!externalSessionId) throw new IdentityInputError('external_session_id must not be empty')
  return `sess_${runtime}_${sha256Hex(`${connectorId}:${runtime}:${externalSessionId}`).slice(0, 24)}`
}

/** codex/domain/sessions.py `stable_session_id(namespace, threadId)`. */
export function codexStableSessionId(namespace: string, threadId: string): string {
  return stableRuntimeSessionId(namespace, 'codex', threadId)
}

/** claude/domain/session.py `stable_session_id(namespace, externalSessionId)`. */
export function claudeStableSessionId(namespace: string, externalSessionId: string): string {
  return stableRuntimeSessionId(namespace, 'claude', externalSessionId)
}

export interface SourceKey {
  readonly kind: string
  readonly key: string
}

/** RuntimeSourceKey validation (instance_models.py `_require_non_blank`). */
export function validateSourceKey(sourceKey: SourceKey): SourceKey {
  for (const [field, value] of [['kind', sourceKey.kind], ['key', sourceKey.key]] as const) {
    if (containsControlCharacter(value)) throw new IdentityInputError(`${field} contains control characters`)
    if (isBlank(value)) throw new IdentityInputError(`${field} must not be empty`)
  }
  return sourceKey
}

/** instance_binding.py `_source_key_digest`: sha256(kind + '\0' + key)[:24]; no validation of its own. */
export function sourceKeyDigest(sourceKey: SourceKey): string {
  return sha256Hex(`${sourceKey.kind}\0${sourceKey.key}`).slice(0, 24)
}

export interface InstanceIdentity {
  readonly connectorId: string
  readonly runtimeType: string
  readonly runtimeId: string
  readonly sourceKey: SourceKey | null
}

/**
 * RuntimeInstanceHost.session_namespace: the legacy instance (runtimeId === runtimeType) keeps the bare
 * connectorId and ignores its source key; named instances use
 * `connectorId:runtimeType:runtimeId[:sourceKeyDigest]`.
 */
export function sessionNamespace(identity: InstanceIdentity): string {
  const sourceKey = identity.sourceKey === null ? null : validateSourceKey(identity.sourceKey)
  if (identity.runtimeId === identity.runtimeType) return identity.connectorId
  const namespace = sourceKey === null ? identity.runtimeId : `${identity.runtimeId}:${sourceKeyDigest(sourceKey)}`
  return `${identity.connectorId}:${identity.runtimeType}:${namespace}`
}

export type HostPlatform = 'darwin' | 'linux' | 'win32'

/**
 * filesystem.py `filesystem_resource_key` for a path that is already `canonical_path()` output
 * (absolute, symlinks resolved, `os.path.normcase` applied — that part needs I/O and lives outside
 * the domain). darwin additionally folds case and composes to NFC.
 */
export function filesystemResourceKey(canonicalPath: string, platform: HostPlatform): string {
  return platform === 'darwin' ? nfc(pythonCasefold(canonicalPath)) : canonicalPath
}

function joinCanonical(base: string, parts: readonly string[], platform: HostPlatform): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const head = base.endsWith(separator) ? base.slice(0, -1) : base
  return [head, ...parts].join(separator)
}

/** DshProvider.session_source_key: keyed by the 1.x endpoint path under DSH_HOME, kept only as identity. */
export function dshSessionSourceKey(canonicalDshHome: string, platform: HostPlatform): SourceKey {
  const endpoint = joinCanonical(canonicalDshHome, ['agents-anywhere', 'bridge', 'endpoint.json'], platform)
  return { kind: 'dsh_bridge_endpoint', key: filesystemResourceKey(endpoint, platform) }
}

/** CodexProvider.session_source_key. */
export function codexSessionSourceKey(canonicalCodexHome: string, platform: HostPlatform): SourceKey {
  return { kind: 'codex_home', key: filesystemResourceKey(canonicalCodexHome, platform) }
}

/** acp/domain/definitions.py `fingerprint`: sha256 of sorted, compact, non-ASCII-preserving JSON. */
export function acpFingerprint(value: JsonValue): string {
  return sha256Hex(pythonJsonDumps(value, { sortKeys: true, ensureAscii: false }))
}

/** AcpRuntime.list_sessions: platform id of an unbound session reported by ACP session/list. */
export function acpNativeInventorySessionId(runtimeId: string, nativeSessionId: string): string {
  return `acp_native_${acpFingerprint([runtimeId, nativeSessionId]).slice(0, 40)}`
}

/** Pi native history scan: platform id of an unbound Pi JSONL session. */
export function piNativeSessionId(runtimeId: string, historyPath: string, nativeSessionId: string): string {
  return `pi_native_${acpFingerprint([runtimeId, historyPath, nativeSessionId]).slice(0, 40)}`
}

/** acp/composition.py `runtime_root`: directory name of one ACP instance's private state. */
export function acpRuntimeRootName(sessionNamespaceValue: string, runtimeId: string): string {
  return sha256Hex(`${sessionNamespaceValue}:${runtimeId}`)
}
