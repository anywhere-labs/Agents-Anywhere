import type { RuntimeCapabilities } from '../application/ports/index.js'
import type { ProtocolCapabilitySet } from '../generated/protocol/v1_2/capability-set.js'

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
