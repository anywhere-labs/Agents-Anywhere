import { AcpAgentProvider, type AcpAgentProviderOptions } from '../provider.js'
import { OFFICIAL_ACP_AGENTS } from './agents.js'

export { ANTIGRAVITY, CODEBUDDY, COMMAND_CODE, COMMAND_CODE_PERMISSION_MODE, MIMO, MINIMAX, OFFICIAL_ACP_AGENTS, OPENCODE, commandCodeDialect, miniMaxDialect } from './agents.js'
export { GENERIC_CLIENT_CAPABILITIES, genericDialect } from './dialect.js'

/** One provider per official ACP Agent. */
export function officialAcpProviders(options: AcpAgentProviderOptions = {}): AcpAgentProvider[] {
  return OFFICIAL_ACP_AGENTS.map(definition => new AcpAgentProvider(definition, options))
}
