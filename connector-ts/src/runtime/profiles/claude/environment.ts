// Claude 适配器进程的环境变量。
//
// v2 Claude 继承 Connector 的完整环境（用户自己的 ANTHROPIC_API_KEY、CLAUDE_CODE_USE_BEDROCK 等照常生效），
// v3 保持这一点。例外是 Connector 自己跑在一个 Claude Code 会话里（开发、测试，或由 Claude Code 拉起）：
// 宿主会给子进程注入 CLAUDECODE、CLAUDE_CODE_* 等标记，以及它托管的 provider 凭据与地址；适配器继承之后会
// 以为自己是宿主的子会话，认证失败（S2 实测 `Authentication required`）。这时剔除这些变量。

import type { ModelGatewayConfig } from '../../../application/ports/runtime-session.js'
import { fail } from '../../acp/errors.js'

/** 宿主 Claude Code 会话的标记。 */
function nestedInClaudeCode(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined
}

export function claudeEnvironment(env: NodeJS.ProcessEnv, gateway?: ModelGatewayConfig): NodeJS.ProcessEnv {
  const nested = nestedInClaudeCode(env)
  // 宿主托管 provider 时，ANTHROPIC_* 是宿主的地址和凭据，不是用户的。
  const hostProvider = nested && env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== undefined
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (nested && (upper.startsWith('CLAUDE') || upper === 'AI_AGENT')) continue
    if (hostProvider && upper.startsWith('ANTHROPIC_')) continue
    out[key] = value
  }
  if (gateway === undefined) return out
  // 模型网关（v2 用 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）：网关的凭据优先，去掉用户自己的 API Key。
  if (gateway.protocol !== 'anthropic') fail('model_gateway_unsupported', 'Claude 只支持 Anthropic 协议的模型网关。')
  delete out.ANTHROPIC_API_KEY
  out.ANTHROPIC_BASE_URL = gateway.baseUrl
  out.ANTHROPIC_AUTH_TOKEN = gateway.authToken
  if (gateway.model !== undefined) out.ANTHROPIC_MODEL = gateway.model
  return out
}
