// Agent 子进程的环境变量边界（v2 acp/infrastructure/processes.py、launch.py `PRIVATE_PREFIXES`）：
// AA 自己的凭据与调试开关不进入 Agent 进程。Profile 只能通过定义里的设置项追加变量。

const PRIVATE_PREFIXES = ['AGENT_', 'AGENTS_ANYWHERE', 'AA_', 'NODE_OPTIONS', 'NODE_INSPECT', 'ELECTRON_']

export interface EnvironmentOptions {
  /** 额外剔除的前缀（Claude profile 剔除宿主 Claude Code 的 `CLAUDE*`、`ANTHROPIC*`）。 */
  readonly stripPrefixes?: readonly string[]
  readonly base?: NodeJS.ProcessEnv
}

export function agentEnvironment(extra: Readonly<Record<string, string>> = {}, options: EnvironmentOptions = {}): NodeJS.ProcessEnv {
  const strip = [...PRIVATE_PREFIXES, ...(options.stripPrefixes ?? [])].map(prefix => prefix.toUpperCase())
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(options.base ?? process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (strip.some(prefix => upper.startsWith(prefix))) continue
    env[key] = value
  }
  return { ...env, ...extra }
}
