import { AcpAgentProvider, type AcpAgentProviderOptions } from '../provider.js'
import { CODEX } from './definition.js'

export { CODEX } from './definition.js'
export { CODEX_GOAL_METHOD, CODEX_HISTORY_RESET, CODEX_SESSION_READ, codexDialect, codexPlanReview } from './dialect.js'
export { codexIdentity } from './identity.js'
export { CODEX_PERMISSIONS, codexPermissionCatalog, codexPermissionSelectionForMode } from './permissions.js'

export function codexProvider(options: AcpAgentProviderOptions = {}): AcpAgentProvider {
  return new AcpAgentProvider(CODEX, options)
}
