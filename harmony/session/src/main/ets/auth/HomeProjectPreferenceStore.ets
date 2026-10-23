import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { parseJsonRecord, objGetArray } from 'common';

const STORE_NAME = 'agents_anywhere_home_project';
const LOG_TAG = 'AgentsAnywhere.HomeProject';

export const PROJECT_STATUS_FILTER_ACTIVE = 'Active';
export const PROJECT_STATUS_FILTER_ARCHIVED = 'Archived';
export const PROJECT_STATUS_FILTER_ALL = 'All';

export class HomeProjectPreferenceStore {
  private static instance: HomeProjectPreferenceStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  private initError: string = '';

  static getInstance(): HomeProjectPreferenceStore {
    if (HomeProjectPreferenceStore.instance === null) {
      HomeProjectPreferenceStore.instance = new HomeProjectPreferenceStore();
    }
    return HomeProjectPreferenceStore.instance;
  }

  init(context: Context): void {
    if (this.readyPromise !== null) {
      return;
    }
    this.readyPromise = preferences.getPreferences(context, { name: STORE_NAME })
      .then((value: preferences.Preferences) => {
        this.store = value;
      })
      .catch((error: BusinessError) => {
        this.initError = error.message;
        hilog.error(0x0000, LOG_TAG, `getPreferences("${STORE_NAME}") failed: ${error.message}`);
      });
  }

  waitUntilReady(): Promise<void> {
    if (this.readyPromise !== null) {
      return this.readyPromise;
    }
    return Promise.resolve();
  }

  private storageKey(serverUrl: string, userId: string): string | null {
    let origin = serverUrl.trim();
    while (origin.endsWith('/')) {
      origin = origin.substring(0, origin.length - 1);
    }
    const trimmedUserId = userId.trim();
    if (origin.length === 0 || trimmedUserId.length === 0) {
      return null;
    }
    return `project-sidebar:${JSON.stringify([origin, trimmedUserId])}`;
  }

  readExpandedIds(serverUrl: string, userId: string): string[] {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return [];
    }
    return this.decodeIds(this.readString(`${key}:ids`, ''));
  }

  setProjectExpanded(serverUrl: string, userId: string, projectId: string, expanded: boolean): void {
    const key = this.storageKey(serverUrl, userId);
    if (key === null || projectId.length === 0) {
      return;
    }
    const ids: string[] = [];
    let present = false;
    for (const id of this.readExpandedIds(serverUrl, userId)) {
      if (id === projectId) {
        present = true;
        continue;
      }
      ids.push(id);
    }
    if (expanded && !present) {
      ids.push(projectId);
    }
    this.putString(`${key}:ids`, JSON.stringify({ 'ids': ids }));
  }

  readProjectsExpanded(serverUrl: string, userId: string): boolean {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return true;
    }
    return this.readBool(`${key}:section`, true);
  }

  setProjectsExpanded(serverUrl: string, userId: string, expanded: boolean): void {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return;
    }
    this.putBool(`${key}:section`, expanded);
  }

  readSessionStatus(serverUrl: string, userId: string): string {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return PROJECT_STATUS_FILTER_ACTIVE;
    }
    const value = this.readString(`${key}:status`, '');
    return value.length > 0 ? value : PROJECT_STATUS_FILTER_ACTIVE;
  }

  selectSessionStatus(serverUrl: string, userId: string, status: string): void {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return;
    }
    this.putString(`${key}:status`, status);
  }

  readSelectedDeviceId(serverUrl: string, userId: string): string | null {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return null;
    }
    const value = this.readString(`${key}:device`, '');
    return value.length > 0 ? value : null;
  }

  selectDevice(serverUrl: string, userId: string, deviceId: string | null): void {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return;
    }
    this.putString(`${key}:device`, deviceId !== null ? deviceId : '');
  }

  readSelectedAgentRuntime(serverUrl: string, userId: string): string | null {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return null;
    }
    const value = this.readString(`${key}:agent`, '');
    return value.length > 0 ? value : null;
  }

  selectAgent(serverUrl: string, userId: string, runtime: string | null): void {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return;
    }
    this.putString(`${key}:agent`, runtime !== null ? runtime : '');
  }

  clearFilters(serverUrl: string, userId: string): void {
    this.selectSessionStatus(serverUrl, userId, PROJECT_STATUS_FILTER_ACTIVE);
    this.selectDevice(serverUrl, userId, null);
    this.selectAgent(serverUrl, userId, null);
  }

  private decodeIds(raw: string): string[] {
    if (raw.trim().length === 0) {
      return [];
    }
    let source: Record<string, Object>;
    try {
      source = parseJsonRecord(raw);
    } catch (error) {
      return [];
    }
    const ids: string[] = [];
    for (const item of objGetArray(source, 'ids')) {
      if (typeof item === 'string' && item.length > 0) {
        ids.push(item);
      }
    }
    return ids;
  }

  private requireStore(): preferences.Preferences {
    const store = this.store;
    if (store === null) {
      if (this.initError.length > 0) {
        throw new Error(`Home project storage failed to initialize: ${this.initError}`);
      }
      throw new Error('Home project storage is not ready yet.');
    }
    return store;
  }

  private readString(key: string, fallback: string): string {
    const store = this.requireStore();
    const value = store.getSync(key, fallback);
    if (typeof value === 'string') {
      return value;
    }
    return fallback;
  }

  private readBool(key: string, fallback: boolean): boolean {
    const store = this.requireStore();
    const value = store.getSync(key, fallback);
    if (typeof value === 'boolean') {
      return value;
    }
    return fallback;
  }

  private putString(key: string, value: string): void {
    const store = this.requireStore();
    store.putSync(key, value);
    store.flush().catch(() => {
    });
  }

  private putBool(key: string, value: boolean): void {
    const store = this.requireStore();
    store.putSync(key, value);
    store.flush().catch(() => {
    });
  }
}
