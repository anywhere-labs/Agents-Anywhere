import { mkdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/** The OS user's home (not `$HOME`): the per-user mutex must not move with the environment (local-machine 2.0). */
export function systemHome(): string {
  return userInfo().homedir
}

/** `~/.agents-anywhere`: v2 files stay here in their v2 format; v3 only adds `v3/` (04-connector.md §6.2). */
export function agentsAnywhereHome(home = systemHome()): string {
  return join(home, '.agents-anywhere')
}

/** The machine-wide Connector record shared with v2, Desktop and the DSH plugin. */
export function runtimeRecordPath(home = systemHome()): string {
  return join(agentsAnywhereHome(home), 'connector-runtime.json')
}

/** The v3 data directory: `~/.agents-anywhere/v3`, or `AGENT_CONNECTOR_DATA_DIR`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, home = systemHome()): string {
  const override = env.AGENT_CONNECTOR_DATA_DIR?.trim()
  return override !== undefined && override !== '' ? override : join(agentsAnywhereHome(home), 'v3')
}

/** v2's data directory (its files live in `<dir>/<connectorId>/<runtimeId>/`): `AGENT_CONNECTOR_DATA_DIR` or `~/.agents-anywhere`. */
export function legacyDataDir(env: NodeJS.ProcessEnv = process.env, home = systemHome()): string {
  const override = env.AGENT_CONNECTOR_DATA_DIR?.trim()
  return override !== undefined && override !== '' ? override : agentsAnywhereHome(home)
}

/** Creates `dir` (and parents) readable by the user only. */
export async function ensurePrivateDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}
