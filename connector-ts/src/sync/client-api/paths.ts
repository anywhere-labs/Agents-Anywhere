// ported from Agents-Anywhere v2 server/agent_server/services/workspace.py @4c8012369 (resolve_workspace_path, _looks_like_windows_path, _clean_remote_path, _resolve_windows_workspace_path, _resolve_posix_workspace_path)
// ported from Agents-Anywhere v2 server/agent_server/api/connector_files.py @4c8012369 (connector_fs_list)
import { posix, win32 } from 'node:path'

const WINDOWS_DRIVE = /^[A-Za-z]:/u

/** Whether a client path is a Windows one (a drive, a UNC prefix, or backslashes without a leading slash). */
export function looksLikeWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || path.startsWith('\\\\') || path.startsWith('//') || (path.includes('\\') && !path.startsWith('/'))
}

/** Trims the path, drops the slash of `/C:...`, and makes an empty path `.`. */
function cleanRemotePath(path: string): string {
  let value = path.trim()
  if (/^\/[A-Za-z]:/u.test(value)) value = value.slice(1)
  return value === '' ? '.' : value
}

function windowsDrive(path: string): string {
  return win32.parse(path).root.replace(/[\\/]+$/u, '').match(/^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)/u)?.[0] ?? ''
}

function resolveWindows(root: string, rawPath: string): string {
  const rootPath = win32.normalize(cleanRemotePath(root))
  const path = cleanRemotePath(rawPath)
  if (path.startsWith('~')) return path
  const drive = windowsDrive(path)
  let resolved: string
  if (drive !== '' && win32.isAbsolute(path)) resolved = path
  else if (path.startsWith('\\') || path.startsWith('/')) resolved = `${windowsDrive(rootPath)}${path}`
  else if (drive !== '') resolved = win32.join(rootPath, path.slice(drive.length).replace(/^[\\/]+/u, ''))
  else resolved = win32.join(rootPath, path)
  return win32.normalize(resolved)
}

function resolvePosix(root: string, rawPath: string): string {
  const rootPath = posix.normalize(cleanRemotePath(root))
  const path = cleanRemotePath(rawPath)
  if (path.startsWith('~')) return path
  if (posix.isAbsolute(path)) return posix.normalize(path)
  return posix.normalize(posix.join(rootPath, path))
}

/**
 * A client path against the workspace root it was chosen under: absolute paths and `~` stay, relative ones join
 * the root, and `..` is collapsed, with the root's own path style (Windows or POSIX) whatever this device runs.
 */
export function resolveWorkspacePath(root: string, rawPath: string): string {
  if (root === '') throw Object.assign(new Error('root is required'), { code: 'invalid_argument' })
  return looksLikeWindowsPath(root) ? resolveWindows(root, rawPath) : resolvePosix(root, rawPath)
}

/**
 * The path `fs/list` hands the workspace: on Windows an empty path lists the drives and stays empty; anything else
 * is resolved against the root.
 */
export function listingPath(platform: NodeJS.Platform, root: string, rawPath: string): string {
  return platform === 'win32' && rawPath === '' ? '' : resolveWorkspacePath(root, rawPath)
}
