import { declaredRuntimeCapabilities, withDeclaredCapabilities } from '../../domain/runtimes/index.js'
import type { Capability, RuntimeCapabilities } from '../ports/index.js'
import type { ProtocolCapabilitySet } from '../../generated/protocol/v1_2/capability-set.js'

/**
 * A Runtime instance's runtime-level capabilities: what its type declares, refined by what its started handle
 * reports (live wins). Without a started handle the declared ones are reported as unavailable.
 */
export function runtimeCapabilities(runtimeType: string, live: RuntimeCapabilities | null): RuntimeCapabilities {
  const declared: readonly Capability[] = declaredRuntimeCapabilities(runtimeType)
  if (live === null) {
    return { revision: 0, items: declared.map(item => (item.supported ? { ...item, available: false, unavailableReason: 'runtime_not_running' } : item)) }
  }
  return { revision: live.revision, items: withDeclaredCapabilities(declared, live.items) }
}

/**
 * A Runtime's capabilities in the protocol 1.2 shape clients read (`runtimeCapabilities` in a snapshot,
 * `capabilities` in `runtime.status`). `available` defaults to `supported`, as the port documents.
 */
export function capabilitySet(capabilities: RuntimeCapabilities, scope: { readonly runtime: string; readonly sessionId: string | null }): ProtocolCapabilitySet {
  return {
    revision: capabilities.revision,
    capabilities: capabilities.items.map(item => ({
      capabilityId: item.id,
      supported: item.supported,
      available: item.available ?? item.supported,
      ...(item.unavailableReason !== undefined ? { unavailableReason: item.unavailableReason } : {}),
      ...(item.parameters !== undefined ? { parameters: item.parameters as Record<string, unknown> } : {}),
      runtime: scope.runtime,
      scope: scope.sessionId === null ? 'runtime' : 'session',
      sessionId: scope.sessionId,
    })),
  }
}
