import { AcpAgentProvider, type AcpAgentProviderOptions } from '../provider.js'
import { CLAUDE } from './definition.js'

export { CLAUDE, CLAUDE_AGENT_ACP_VERSION } from './definition.js'
export { CLAUDE_AIR_CAPABILITIES, claudeDialect, claudePlanReview, goalControlMethod } from './dialect.js'
export { claudeEnvironment } from './environment.js'
export { claudeIdentity } from './identity.js'
export { CLAUDE_PERMISSION_MODES, claudePermissionCatalog } from './permissions.js'

export function claudeProvider(options: AcpAgentProviderOptions = {}): AcpAgentProvider {
  return new AcpAgentProvider(CLAUDE, options)
}
