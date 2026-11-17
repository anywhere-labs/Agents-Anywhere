// Environment variables for the Claude adapter process.
//
// The adapter inherits the Connector's full environment (the user's own ANTHROPIC_API_KEY,
// CLAUDE_CODE_USE_BEDROCK, etc. keep working). The exception is a Connector that itself runs inside a Claude Code
// session (development, tests, or launched by Claude Code): the host injects markers such as CLAUDECODE and
// CLAUDE_CODE_* into child processes, plus the provider credentials and URL it manages. An adapter that inherits
// them believes it is a child session of the host and fails to authenticate (S2: `Authentication required`), so
// those variables are removed.

import type { ModelGatewayConfig } from '../../../application/ports/runtime-session.js'
import { fail } from '../../acp/errors.js'

/** Markers of a host Claude Code session. */
function nestedInClaudeCode(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined
}

export function claudeEnvironment(env: NodeJS.ProcessEnv, gateway?: ModelGatewayConfig): NodeJS.ProcessEnv {
  const nested = nestedInClaudeCode(env)
  // When the host manages the provider, ANTHROPIC_* are the host's URL and credentials, not the user's.
  const hostProvider = nested && env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== undefined
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (nested && (upper.startsWith('CLAUDE') || upper === 'AI_AGENT')) continue
    if (hostProvider && upper.startsWith('ANTHROPIC_')) continue
    out[key] = value
  }
  if (gateway === undefined) return out
  // Model gateway via ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN: the gateway's credentials win and the user's own
  // API key is removed.
  if (gateway.protocol !== 'anthropic') fail('model_gateway_unsupported', 'Claude 只支持 Anthropic 协议的模型网关。')
  delete out.ANTHROPIC_API_KEY
  out.ANTHROPIC_BASE_URL = gateway.baseUrl
  out.ANTHROPIC_AUTH_TOKEN = gateway.authToken
  if (gateway.model !== undefined) out.ANTHROPIC_MODEL = gateway.model
  return out
}
