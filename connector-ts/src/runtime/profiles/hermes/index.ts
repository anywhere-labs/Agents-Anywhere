import { AcpAgentProvider, type AcpAgentProviderOptions } from '../provider.js'
import { HERMES } from './definition.js'

export { HERMES } from './definition.js'
export { EDIT_POLICY_OPTION, hermesDialect } from './dialect.js'

export function hermesProvider(options: AcpAgentProviderOptions = {}): AcpAgentProvider {
  return new AcpAgentProvider(HERMES, options)
}
