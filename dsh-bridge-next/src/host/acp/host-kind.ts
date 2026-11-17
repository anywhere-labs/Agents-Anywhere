/**
 * Which DSH this plugin runs in, for the hello (contracts/dsh-bridge/3.0 `hostKind`). DSH has no
 * API that names its front end, so this reads the process: DSH Desktop's backend runs under
 * Electron, and `dsh web` is the CLI's `web` subcommand. Anything else is reported as unknown;
 * the value is shown to users and used for diagnostics, never to decide behaviour.
 */
export type HostKind = 'desktop' | 'web' | 'headless' | 'unknown'

export function detectHostKind(proc: Pick<NodeJS.Process, 'versions' | 'env' | 'argv'> = process): HostKind {
  if (proc.versions.electron || proc.env.ELECTRON_RUN_AS_NODE) return 'desktop'
  const args = proc.argv.slice(2)
  // The first positional argument, skipping the value of `--profile <name>`.
  const command = args.find((argument, index) => !argument.startsWith('-') && args[index - 1] !== '--profile')
  if (command === 'web') return 'web'
  return 'unknown'
}
