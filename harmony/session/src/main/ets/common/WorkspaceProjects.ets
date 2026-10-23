import { RemoteProject } from 'network';

function isWindowsPath(path: string, deviceOs: string | null): boolean {
  if (deviceOs === 'windows') {
    return true;
  }
  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    return true;
  }
  return path.startsWith('\\\\');
}

export function workspacePathKey(path: string, deviceOs: string | null = null): string {
  const trimmed = path.trim();
  const windows = isWindowsPath(trimmed, deviceOs);
  const slashes = windows ? trimmed.replace(/\\/g, '/') : trimmed;
  const parts: string[] = [];
  const rawParts = slashes.split('/');
  for (const part of rawParts) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (!windows && part === '..') {
      if (parts.length > 0) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  let prefix = '';
  if (slashes.startsWith('//') && !slashes.startsWith('///')) {
    prefix = '//';
  } else if (slashes.startsWith('/')) {
    prefix = '/';
  }
  const key = prefix + parts.join('/');
  if (windows) {
    return key.toLowerCase();
  }
  return key;
}

export function workspaceProject(projects: RemoteProject[], connectorId: string, path: string,
  deviceOs: string | null = null): RemoteProject | null {
  const key = workspacePathKey(path, deviceOs);
  if (key.length === 0) {
    return null;
  }
  for (const project of projects) {
    if (project.connectorId !== connectorId) {
      continue;
    }
    if (workspacePathKey(project.workspacePath, deviceOs) === key) {
      return project;
    }
  }
  return null;
}

export function workspaceProjectName(path: string): string {
  const windows = isWindowsPath(path, null);
  const trimmed = path.trim();
  const replaced = windows ? trimmed.replace(/\\/g, '/') : trimmed;
  let normalized = replaced;
  while (normalized.endsWith('/')) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  if (windows && (/^[a-zA-Z]:$/.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized))) {
    return 'Workspace';
  }
  const slashIndex = normalized.lastIndexOf('/');
  const name = slashIndex >= 0 ? normalized.substring(slashIndex + 1) : normalized;
  if (name.length === 0) {
    return 'Workspace';
  }
  return name;
}

function limitCodePoints(value: string, count: number): string {
  let result = '';
  let used = 0;
  for (const ch of value) {
    if (used >= count) {
      break;
    }
    result += ch;
    used++;
  }
  return result;
}

export function availableProjectName(name: string, projects: RemoteProject[]): string {
  const base = limitCodePoints(name.trim().length === 0 ? 'Workspace' : name.trim(), 255);
  const names: string[] = [];
  for (const project of projects) {
    names.push(project.name);
  }
  let candidate = base;
  let suffix = 1;
  while (names.indexOf(candidate) >= 0) {
    const ending = ` (${suffix})`;
    suffix++;
    candidate = limitCodePoints(base, 255 - ending.length) + ending;
  }
  return candidate;
}
