// Whether the Codex App is installed for this user, without starting it.
//
// - macOS: ChatGPT.app (which hosts the Codex App) or Codex.app under /Applications or ~/Applications;
// - Windows: the per-user data folder of the Codex package (%LOCALAPPDATA%\Packages\OpenAI.Codex_*), since the
//   package itself under WindowsApps cannot be listed by the user;
// - Linux: a desktop entry that handles the `codex://` scheme.
// The file system is injected so tests never look at the real machine.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface InstallProbe {
  /** Whether a directory exists. */
  isDirectory(path: string): boolean
  /** Entry names of a directory; empty when it cannot be read. */
  list(path: string): readonly string[]
  /** A small text file's content; undefined when it cannot be read. */
  read(path: string): string | undefined
}

export const systemInstallProbe: InstallProbe = {
  isDirectory: path => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  list: path => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  read: path => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
}

const MAC_BUNDLES = ['ChatGPT.app', 'Codex.app']
const WINDOWS_PACKAGE_PREFIX = 'openai.codex_'
const LINUX_SCHEME_HANDLER = 'x-scheme-handler/codex'

function linuxApplicationDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(dir => dir !== '')
  return [dataHome, ...dataDirs, join(home, '.local', 'share', 'flatpak', 'exports', 'share'), '/var/lib/flatpak/exports/share']
    .map(dir => join(dir, 'applications'))
}

export function codexAppInstalled(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, probe: InstallProbe = systemInstallProbe): boolean {
  if (platform === 'darwin') {
    return ['/Applications', join(home, 'Applications')].some(dir => MAC_BUNDLES.some(bundle => probe.isDirectory(join(dir, bundle))))
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return probe.list(join(local, 'Packages')).some(name => name.toLowerCase().startsWith(WINDOWS_PACKAGE_PREFIX))
  }
  if (platform === 'linux') {
    return linuxApplicationDirectories(env, home).some(dir => probe.list(dir)
      .filter(name => name.endsWith('.desktop'))
      .some(name => probe.read(join(dir, name))?.includes(LINUX_SCHEME_HANDLER) === true))
  }
  return false
}
