import { HttpTransport } from './HttpTransport';
import { AAApiError } from './ApiError';
import { compareUpdateVersions } from './UpdateVersion';
import { AppConfig } from '../config/AppConfig';

/**
 * The update check.
 *
 * Port of `api/AppUpdates.kt`.
 *
 * `/health` is the only unauthenticated endpoint the client polls: it answers
 * with the Server's version, and a version newer than this client's means a new
 * build is available. The download address is client-side configuration rather
 * than part of the answer, which is why it comes from `AppConfig`.
 */

export class AndroidAppRelease {
  readonly versionName: string;
  readonly downloadUrl: string;

  constructor(versionName: string, downloadUrl: string) {
    this.versionName = versionName;
    this.downloadUrl = downloadUrl;
  }
}

export class AppUpdatesApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** The newer release, or `null` when this client is current. */
  async check(serverUrl: string, currentVersionName: string): Promise<AndroidAppRelease | null> {
    const body: Object = await this.transport.getJson(serverUrl, '/health');
    const payload: Record<string, Object> = body as Record<string, Object>;
    const status: Object = payload['status'];
    if (typeof status !== 'string' || status !== 'ok') {
      throw new AAApiError('Server health check failed.');
    }
    const versionValue: Object = payload['version'];
    const latestVersion: string = typeof versionValue === 'string' ? versionValue.trim() : '';
    const comparison: number | null = compareUpdateVersions(latestVersion, currentVersionName);
    if (comparison === null) {
      throw new AAApiError('Server health response has no valid version.');
    }
    if (comparison <= 0) {
      return null;
    }
    return new AndroidAppRelease(latestVersion, AppConfig.UPDATE_DOWNLOAD_URL);
  }
}
