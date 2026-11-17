// Environment variable boundary for Agent child processes: AA's own credentials and debug switches never reach the
// Agent process. Profiles can add variables only through settings in their definition.

const PRIVATE_PREFIXES = ['AGENT_', 'AGENTS_ANYWHERE', 'AA_', 'NODE_OPTIONS', 'NODE_INSPECT', 'ELECTRON_']

export interface EnvironmentOptions {
  /** Extra prefixes to strip (the Claude profile strips the host Claude Code's `CLAUDE*`, `ANTHROPIC*`). */
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
