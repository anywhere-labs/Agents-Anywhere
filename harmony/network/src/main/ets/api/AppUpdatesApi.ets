import { ApiClient } from './ApiClient';
import { objGetOptString, objGetString } from 'common';
import { ApiException } from 'common';

export interface AppRelease {
  versionName: string;
  downloadUrl: string;
}

// The in-app update action opens this page via openLink; replace it with the
// fixed package address once the HarmonyOS build is published (e.g. AppGallery).
export const UPDATE_DOWNLOAD_URL = 'https://agents-anywhere.com/download';

interface ParsedUpdateVersion {
  release: number[];
  pre: string[];
}

const UPDATE_VERSION_PATTERN =
  /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)|((?:a|b|rc|dev)\d+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseUpdateVersion(value: string): ParsedUpdateVersion | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return null;
  }
  const match = UPDATE_VERSION_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }
  let suffix = match[2] ?? '';
  if (suffix.length === 0 && (match[3] ?? '').length > 0) {
    const legacy = match[3] ?? '';
    const legacyMatch = /^(\D+)(\d+)$/.exec(legacy);
    if (legacyMatch === null) {
      suffix = legacy;
    } else {
      suffix = `${legacyMatch[1]}.${legacyMatch[2]}`;
    }
  }
  const release: number[] = [];
  const segments = match[1].split('.');
  for (const segment of segments) {
    const parsed = parseInt(segment);
    if (Number.isNaN(parsed)) {
      return null;
    }
    release.push(parsed);
  }
  const pre: string[] = [];
  if (suffix.length > 0) {
    const preSegments = suffix.split('.');
    for (const segment of preSegments) {
      pre.push(segment);
    }
  }
  const parsedVersion: ParsedUpdateVersion = {
    release: release,
    pre: pre
  };
  return parsedVersion;
}

/** Compare release names, including the Server's four numeric segments. */
export function compareUpdateVersions(left: string, right: string): number | null {
  const a = parseUpdateVersion(left);
  const b = parseUpdateVersion(right);
  if (a === null || b === null) {
    return null;
  }
  const releaseCount = a.release.length > b.release.length ? a.release.length : b.release.length;
  for (let index = 0; index < releaseCount; index++) {
    const x = index < a.release.length ? a.release[index] : 0;
    const y = index < b.release.length ? b.release[index] : 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length > 0) {
      return -1;
    }
    if (b.pre.length > 0) {
      return 1;
    }
    return 0;
  }
  const preCount = a.pre.length > b.pre.length ? a.pre.length : b.pre.length;
  for (let index = 0; index < preCount; index++) {
    if (index >= a.pre.length) {
      return -1;
    }
    if (index >= b.pre.length) {
      return 1;
    }
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) {
      continue;
    }
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) {
      const xnValue = parseInt(x);
      const ynValue = parseInt(y);
      if (xnValue !== ynValue) {
        return xnValue < ynValue ? -1 : 1;
      }
      continue;
    }
    if (xn !== yn) {
      return xn ? -1 : 1;
    }
    if (x < y) {
      return -1;
    }
    return 1;
  }
  return 0;
}

export class AppUpdatesApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async check(serverUrl: string, currentVersionName: string): Promise<AppRelease | null> {
    const payload = await this.client.getJson(serverUrl, '/health');
    if (objGetString(payload, 'status', '') !== 'ok') {
      throw new ApiException('Server health check failed.');
    }
    const latestVersion = (objGetOptString(payload, 'version') ?? '').trim();
    const comparison = compareUpdateVersions(latestVersion, currentVersionName);
    if (comparison === null) {
      throw new ApiException('Server health response has no valid version.');
    }
    if (comparison <= 0) {
      return null;
    }
    const release: AppRelease = {
      versionName: latestVersion,
      downloadUrl: UPDATE_DOWNLOAD_URL
    };
    return release;
  }
}
