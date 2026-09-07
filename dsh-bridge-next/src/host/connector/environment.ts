import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'
import type { ConnectorSettings } from '../../contracts/connector.js'

export async function resolveUv(config: ResolvedConfig, settings: ConnectorSettings): Promise<string | null> {
  const command = settings.uvPath || config.uvPath
  const home = userInfo().homedir
  const paths = [
    ...(process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'), join(home, '.cargo', 'bin'),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ]
  const names = process.platform === 'win32' && !command.endsWith('.exe') ? [command, `${command}.exe`] : [command]
  const candidates = isAbsolute(command) ? [command] : paths.flatMap(path => names.map(name => join(path, name)))
  for (const candidate of new Set(candidates)) {
    try { await access(candidate, constants.X_OK); return candidate } catch { /* Try the next PATH entry. */ }
  }
  return null
}

export function canOpenFolders(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32' || Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'])
}

/** Called only for a Host-owned directory selected by the user, never a client-supplied path. */
export async function openFolder(path: string): Promise<void> {
  if (!canOpenFolders()) throw new Error('当前为无图形界面环境，请使用页面显示的目录路径。')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  try { await promisify(execFile)(command, [path], { timeout: 5_000, windowsHide: true }) }
  catch { throw new Error('无法打开目录，请使用页面显示的路径手动打开。') }
}
