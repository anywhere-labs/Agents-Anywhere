import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'
import type { ConnectorSettings } from '../../contracts/connector.js'

/** Host-side locale detection also works before a Client connects or in headless mode. */
export async function systemLanguages(): Promise<string[]> {
  const languages = [Intl.DateTimeFormat().resolvedOptions().locale]
  const locale = process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG']
  if (locale) languages.push(locale)
  languages.push(...(process.env['LANGUAGE'] ?? '').split(':').filter(Boolean))
  if (process.platform === 'darwin') {
    try {
      // Node can inherit an English shell locale even when macOS prefers Chinese.
      const { stdout } = await promisify(execFile)('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], {
        encoding: 'utf8', timeout: 1500, windowsHide: true,
      })
      languages.push(...(stdout.match(/[a-z]{2,3}(?:[-_][a-z0-9]+)*/gi) ?? []))
    } catch { /* Use Intl and POSIX locales when system preferences are unavailable. */ }
  }
  return languages
}

const PYPI_SIMPLE = 'https://pypi.org/simple'

/**
 * The chosen PyPI mirror is uv's first index and the official PyPI its
 * fallback: uv takes each package from the first index that has it, so a
 * mirror that filters large wheels (TUNA, USTC and BFSU carry no
 * openai-codex) still installs. Every index is set explicitly, because the
 * bundled project and the inherited environment may declare others; an
 * inherited `UV_INDEX` is dropped when no mirror is chosen. Desktop applies
 * the same rule (desktop-workbench/electron/connector-supervisor.ts).
 */
export function withPackageIndexes(environment: NodeJS.ProcessEnv, pypiIndexUrl: string): NodeJS.ProcessEnv {
  const mirror = pypiIndexUrl.trim().replace(/\/+$/, '')
  const { UV_INDEX: _inherited, ...rest } = environment
  return {
    ...rest,
    UV_DEFAULT_INDEX: PYPI_SIMPLE,
    UV_INDEX_URL: PYPI_SIMPLE,
    ...(mirror && mirror !== PYPI_SIMPLE ? { UV_INDEX: mirror } : {}),
    PIP_INDEX_URL: mirror || PYPI_SIMPLE,
  }
}

export async function resolveUv(config: ResolvedConfig, settings: ConnectorSettings): Promise<string | null> {
  const command = settings.uvPath || config.uvPath
  if (!settings.uvPath && config.uvPath === 'uv') {
    try {
      // Resolve through the declared dependency so pnpm's isolated layout works.
      // Use the native binary directly, including when install scripts are disabled.
      const require = createRequire(import.meta.url)
      const provider = require.resolve('@dataiku/uv/package.json')
      const binaryPackage = createRequire(provider).resolve(`@dataiku/uv-${process.platform}-${process.arch}/package.json`)
      const bundled = join(dirname(binaryPackage), 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
      await access(bundled, constants.X_OK)
      return bundled
    } catch { /* Missing optional dependency or unsupported platform: try system uv. */ }
  }
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
  if (!canOpenFolders()) throw new Error('当前环境不支持打开本机目录。')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  try { await promisify(execFile)(command, [path], { timeout: 5_000, windowsHide: true }) }
  catch { throw new Error('无法打开目录，请检查本机文件管理器是否可用。') }
}
