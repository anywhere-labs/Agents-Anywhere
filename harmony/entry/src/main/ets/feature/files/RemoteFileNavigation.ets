import { RemoteDirectory, RemoteDirectoryEntry } from '../../api/FilesDtos';

/**
 * Remote path rules.
 *
 * Port of `feature/files/RemoteFileNavigation.kt`.
 *
 * A connector can serve a POSIX host or a Windows one, and the two disagree about
 * what a path means: POSIX paths are relative to a root the Server picked, while a
 * Windows path carries its own drive. Every function here is pure and exists so the
 * browser can be reasoned about — and tested — without a device.
 */

export interface RemoteFileRequest {
  root: string;
  path: string;
}

export function isWindowsDeviceOs(deviceOs: string | null): boolean {
  return deviceOs !== null && deviceOs.toLowerCase() === 'windows';
}

/** Windows starts at the drive overview (""), everything else at ".". */
export function initialRemoteFilePath(deviceOs: string | null): string {
  return isWindowsDeviceOs(deviceOs) ? '' : '.';
}

export function remoteFileRequest(
  targetPath: string,
  deviceOs: string | null,
  fallbackRoot: string | null,
): RemoteFileRequest {
  const normalizedPath: string = normalizeRemotePath(targetPath);
  const rootFallback: string = fallbackRoot !== null && fallbackRoot.trim().length > 0
    ? fallbackRoot
    : '~';
  if (isWindowsDeviceOs(deviceOs) && normalizedPath.trim().length === 0) {
    return { root: rootFallback, path: '' };
  }
  const root: string = isWindowsDeviceOs(deviceOs)
    ? (windowsDriveRoot(normalizedPath) ?? rootFallback)
    : rootFallback;
  return {
    root: root,
    path: normalizedPath.trim().length > 0 ? normalizedPath : '.',
  };
}

export function remoteRootForPath(
  targetPath: string,
  deviceOs: string | null,
  fallbackRoot: string | null,
): string {
  return remoteFileRequest(targetPath, deviceOs, fallbackRoot).root;
}

/**
 * The path a listing should be treated as having.
 *
 * A Server that answers with `.` while a real path was requested is reporting a
 * relative answer, so the requested path wins; a Windows drive keeps its shape.
 */
export function canonicalRemoteDirectoryPath(
  request: RemoteFileRequest,
  returnedPath: string,
  deviceOs: string | null,
): string {
  const requested: string = normalizeRemotePath(request.path).trim();
  const returned: string = normalizeRemotePath(returnedPath).trim();
  if (isWindowsDeviceOs(deviceOs)) {
    if (requested.length === 0) {
      return '';
    }
    return canonicalWindowsPath(returned.length === 0 || returned === '.' ? requested : returned);
  }
  if (requested === '/') {
    return '/';
  }
  if (requested.startsWith('/') && (returned.length === 0 || returned === '.')) {
    return requested;
  }
  if (returned.length === 0) {
    return requested.length > 0 ? requested : '.';
  }
  if (returned === '.' && requested !== '.') {
    return requested;
  }
  return returned;
}

export function remoteParentPath(
  rawPath: string,
  deviceOs: string | null,
  allowWindowsDriveOverview: boolean = true,
): string | null {
  const normalized: string = normalizeRemotePath(rawPath).trim();
  if (normalized.length === 0) {
    return null;
  }
  return isWindowsDeviceOs(deviceOs)
    ? windowsParentPath(normalized, allowWindowsDriveOverview)
    : posixParentPath(normalized);
}

/** True for the Windows "list the drives" pseudo-path. */
export function isWindowsDriveOverview(rawPath: string, deviceOs: string | null): boolean {
  return isWindowsDeviceOs(deviceOs) && normalizeRemotePath(rawPath).trim().length === 0;
}

export function isSelectableRemoteDirectory(rawPath: string, deviceOs: string | null): boolean {
  return normalizeRemotePath(rawPath).trim().length > 0
    && !isWindowsDriveOverview(rawPath, deviceOs);
}

/** The path shown in the path bar: the root joined with a relative path. */
export function displayRemotePath(
  root: string | null,
  rawPath: string,
  deviceOs: string | null,
  windowsDriveOverviewLabel: string = '.',
): string {
  if (isWindowsDriveOverview(rawPath, deviceOs)) {
    return windowsDriveOverviewLabel;
  }
  const base: string = root === null ? '' : root.trim().replace(/[/\\]+$/, '');
  const path: string = normalizeRemotePath(rawPath).trim().replace(/\\/g, '/');
  if (path.length === 0 || path === '.') {
    return base.length > 0 ? base : '.';
  }
  if (path === '/') {
    return '/';
  }
  if (path.startsWith('/') || /^[A-Za-z]:\/.*/.test(path)) {
    return path;
  }
  return base.length === 0 ? path : `${base}/${path.replace(/^\/+/, '')}`;
}

export function fileNameFromRemotePath(rawPath: string): string {
  const normalized: string = normalizeRemotePath(rawPath)
    .trim()
    .replace(/[/\\]+$/, '')
    .replace(/\\/g, '/');
  const slash: number = normalized.lastIndexOf('/');
  const tail: string = slash >= 0 ? normalized.substring(slash + 1) : normalized;
  if (tail.length > 0) {
    return tail;
  }
  return normalized.length > 0 ? normalized : 'Untitled';
}

/** Strips a leading slash before a drive letter, which the connector rejects. */
export function normalizeRemotePath(rawPath: string): string {
  return rawPath.replace(/^\/([A-Za-z]:)(?=$|[/\\])/, '$1');
}

/** `C:\` for a path that names a drive, or null. */
export function windowsDriveRoot(rawPath: string): string | null {
  const normalized: string = normalizeRemotePath(rawPath).trim();
  const match: RegExpMatchArray | null = normalized.match(/^([A-Za-z]:)(?:[/\\].*)?$/);
  if (match === null) {
    return null;
  }
  return `${match[1]}\\`;
}

function canonicalWindowsPath(rawPath: string): string {
  const normalized: string = normalizeRemotePath(rawPath).trim().replace(/\//g, '\\');
  const drive: RegExpMatchArray | null = normalized.match(/^([A-Za-z]:)\\?$/);
  if (drive !== null) {
    return `${drive[1]}\\`;
  }
  return normalized;
}

function posixParentPath(rawPath: string): string | null {
  const trimmed: string = rawPath.trim().replace(/\/+$/, '');
  const clean: string = trimmed.length > 0 ? trimmed : '.';
  if (clean === '.' || clean === '/' || clean === '~') {
    return null;
  }
  const slash: number = clean.lastIndexOf('/');
  if (slash < 0) {
    return '.';
  }
  return slash === 0 ? '/' : clean.substring(0, slash);
}

function windowsParentPath(rawPath: string, allowDriveOverview: boolean): string | null {
  const trimmed: string = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const clean: string = trimmed.length > 0 ? trimmed : '.';
  if (clean === '.' || clean === '~') {
    return null;
  }
  if (/^[A-Za-z]:$/.test(clean)) {
    return allowDriveOverview ? '' : null;
  }
  if (!/^[A-Za-z]:\//.test(clean)) {
    const parent: string | null = posixParentPath(clean);
    return parent === null ? null : parent.replace(/\//g, '\\');
  }
  const slash: number = clean.lastIndexOf('/');
  if (slash < 0) {
    return null;
  }
  if (slash === 2) {
    return `${clean.substring(0, 2)}\\`;
  }
  return clean.substring(0, slash).replace(/\//g, '\\');
}

// ------------------------------------------------------------ controller glue

/** One row in the browser: the file-entry shape the screens consume. */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number | null;
}

export interface FilesDirectory {
  path: string;
  entries: FileEntry[];
}

/** A loaded text file, with the Server's truncation and binary flags. */
export interface TextFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  encoding: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export function emptyDirectory(path: string): FilesDirectory {
  return { path: path, entries: [] };
}

/**
 * Turns a listing into the rows the browser shows.
 *
 * Android's `FilesController.listFiles`: anything that is neither a directory nor
 * a file is dropped, and directories sort before files, each alphabetically.
 */
export function toFilesDirectory(
  path: string,
  entries: RemoteDirectoryEntry[],
): FilesDirectory {
  const rows: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'directory' && entry.type !== 'file') {
      continue;
    }
    rows.push({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.type === 'directory',
      size: entry.size,
    });
  }
  rows.sort((left: FileEntry, right: FileEntry) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    const leftName: string = left.name.toLowerCase();
    const rightName: string = right.name.toLowerCase();
    if (leftName === rightName) {
      return 0;
    }
    return leftName < rightName ? -1 : 1;
  });
  return { path: path, entries: rows };
}

/** Normalizes both the directory and its entries, as Android does before display. */
export function normalizedRemotePaths(directory: FilesDirectory): FilesDirectory {
  const entries: FileEntry[] = [];
  for (const entry of directory.entries) {
    entries.push({
      name: entry.name,
      path: normalizeRemotePath(entry.path),
      isDirectory: entry.isDirectory,
      size: entry.size,
    });
  }
  return { path: normalizeRemotePath(directory.path), entries: entries };
}

/** Applies the canonical path rule to a listing. */
export function canonicalRemotePaths(
  directory: FilesDirectory,
  request: RemoteFileRequest,
  deviceOs: string | null,
): FilesDirectory {
  const normalized: FilesDirectory = normalizedRemotePaths(directory);
  return {
    path: canonicalRemoteDirectoryPath(request, normalized.path, deviceOs),
    entries: normalized.entries,
  };
}

/** True when the listing the Server returned was cut short. */
export function directoryTruncated(directory: RemoteDirectory): boolean {
  return directory.truncated;
}
