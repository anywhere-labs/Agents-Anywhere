import { getColors } from '../designsystem/ColorTokens';

export function isWindowsDriveStylePath(path: string): boolean {
  if (path.length < 2) {
    return false;
  }
  const first = path.charAt(0);
  const isLetter = (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z');
  return isLetter && path.charAt(1) === ':';
}

// Windows-only entries that carry the hidden/system attribute or are legacy
// compatibility junctions; the fs/list payload has no hidden flag, so these
// well-known names are filtered client-side.
const HIDDEN_WINDOWS_ENTRY_NAMES: string[] = [
  'appdata',
  'application data',
  'config.msi',
  'cookies',
  'desktop.ini',
  'documents and settings',
  'dumpstack.log',
  'dumpstack.log.tmp',
  'hiberfil.sys',
  'local settings',
  'msocache',
  'my documents',
  'nethood',
  'pagefile.sys',
  'printhood',
  'recent',
  'recovery',
  'sendto',
  'start menu',
  'swapfile.sys',
  'system volume information',
  'templates'
];

export function isHiddenFileEntryName(name: string, windowsDevice: boolean): boolean {
  if (name.length === 0) {
    return false;
  }
  if (name.charAt(0) === '.') {
    return true;
  }
  if (!windowsDevice) {
    return false;
  }
  if (name.charAt(0) === '$') {
    return true;
  }
  const lower = name.toLowerCase();
  for (let i = 0; i < HIDDEN_WINDOWS_ENTRY_NAMES.length; i++) {
    if (lower === HIDDEN_WINDOWS_ENTRY_NAMES[i]) {
      return true;
    }
  }
  return false;
}

export function isWindowsDeviceOs(deviceOs: string | null): boolean {
  return deviceOs !== null && deviceOs.toLowerCase() === 'windows';
}

export function initialRemoteFilePath(deviceOs: string | null): string {
  return isWindowsDeviceOs(deviceOs) ? '' : '.';
}

export function isWindowsDriveRootPath(path: string): boolean {
  if (!isWindowsDriveStylePath(path)) {
    return false;
  }
  const rest = path.substring(2);
  return rest.length === 0 || rest === '\\' || rest === '/';
}

export function windowsDriveRootOf(path: string): string {
  return `${path.substring(0, 1)}:\\`;
}

export function windowsParentPath(path: string): string {
  const normalized = path.replace(/\//g, '\\');
  const slashIndex = normalized.lastIndexOf('\\');
  if (slashIndex < 0) {
    return path;
  }
  const parent = normalized.substring(0, slashIndex);
  if (parent.length <= 2) {
    return windowsDriveRootOf(normalized);
  }
  return parent;
}

export function fileEntryKind(name: string, isDirectory: boolean): string {
  if (isDirectory) {
    return 'directory';
  }
  const lower = name.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.kt') || lower.endsWith('.py')
    || lower.endsWith('.rs') || lower.endsWith('.go') || lower.endsWith('.java') || lower.endsWith('.c')
    || lower.endsWith('.h') || lower.endsWith('.sh')) {
    return 'code';
  }
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json') || lower.endsWith('.yaml')
    || lower.endsWith('.yml')) {
    return 'text';
  }
  return 'doc';
}

export function fileEntrySymbol(kind: string): Resource {
  if (kind === 'directory') {
    return $r('sys.symbol.folder');
  }
  if (kind === 'code') {
    return $r('sys.symbol.code');
  }
  if (kind === 'text') {
    return $r('sys.symbol.doc_text');
  }
  return $r('sys.symbol.doc');
}

export function fileEntrySymbolColor(kind: string): string {
  if (kind === 'directory') {
    return getColors().accentPurple;
  }
  if (kind === 'code') {
    return getColors().primaryAction;
  }
  if (kind === 'text') {
    return getColors().noticeSuccess;
  }
  return getColors().muted;
}

export function fileContentLines(content: string): string[] {
  const raw = content.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    if (line.endsWith('\r')) {
      line = line.substring(0, line.length - 1);
    }
    lines.push(line);
  }
  return lines;
}

export function findMatchLineIndexes(lines: string[], query: string): number[] {
  const result: number[] = [];
  if (query.trim().length === 0) {
    return result;
  }
  const needle = query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const haystack = lines[i].toLowerCase();
    let from = haystack.indexOf(needle);
    while (from >= 0) {
      result.push(i);
      from = haystack.indexOf(needle, from + needle.length);
    }
  }
  return result;
}

export class FilePreviewLine {
  text: string = '';
  lineIndex: number = 0;
  isMatch: boolean = false;
  isCurrent: boolean = false;
}

export class FilePreviewLineDataSource implements IDataSource {
  private lines: FilePreviewLine[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.lines.length;
  }

  getData(index: number): FilePreviewLine {
    return this.lines[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  reload(lines: FilePreviewLine[]): void {
    this.lines = lines;
    const listeners = this.listeners.slice(0);
    for (const listener of listeners) {
      listener.onDataReloaded();
    }
  }

  setCurrent(previousIndex: number, nextIndex: number): void {
    const hasPrevious = previousIndex >= 0 && previousIndex < this.lines.length;
    const hasNext = nextIndex >= 0 && nextIndex < this.lines.length;
    if (hasPrevious) {
      this.lines[previousIndex].isCurrent = false;
    }
    if (hasNext) {
      this.lines[nextIndex].isCurrent = true;
    }
    const listeners = this.listeners.slice(0);
    for (const listener of listeners) {
      if (hasPrevious) {
        listener.onDataChange(previousIndex);
      }
      if (hasNext && nextIndex !== previousIndex) {
        listener.onDataChange(nextIndex);
      }
    }
  }
}
