import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { parseJsonRecord, objGetArray, objGetOptString, recordOrNull } from 'common';

const STORE_NAME = 'agents_anywhere_new_session';
const LOG_TAG = 'AgentsAnywhere.NewSession';

// One persisted selection for a (connectorId, runtimeId) scope. Mirrors
// Android NewSessionPreferenceStore entries.
export interface NewSessionStoredSelection {
  connectorId: string;
  runtimeId: string;
  model: string | null;
  permission: string | null;
}

export interface NewSessionPreference {
  connectorId: string;
  runtimeId: string;
  selections: NewSessionStoredSelection[];
}

export class NewSessionPreferenceStore {
  private static instance: NewSessionPreferenceStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  private initError: string = '';

  static getInstance(): NewSessionPreferenceStore {
    if (NewSessionPreferenceStore.instance === null) {
      NewSessionPreferenceStore.instance = new NewSessionPreferenceStore();
    }
    return NewSessionPreferenceStore.instance;
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

  // Storage key scoped by server origin and user id, mirroring Android
  // "last-selection-v2:[serverUrl,userId]".
  private storageKey(serverUrl: string, userId: string): string | null {
    let origin = serverUrl.trim();
    while (origin.endsWith('/')) {
      origin = origin.substring(0, origin.length - 1);
    }
    if (origin.length === 0 || userId.trim().length === 0) {
      return null;
    }
    const key = `last-selection-v2:${JSON.stringify([origin, userId.trim()])}`;
    return key;
  }

  readPreference(serverUrl: string, userId: string): NewSessionPreference | null {
    const key = this.storageKey(serverUrl, userId);
    if (key === null) {
      return null;
    }
    return this.decodePreference(this.readString(key, ''));
  }

  saveTarget(serverUrl: string, userId: string, connectorId: string, runtimeId: string): void {
    this.update(serverUrl, userId, connectorId, runtimeId, null, null, false);
  }

  saveModel(serverUrl: string, userId: string, connectorId: string, runtimeId: string,
    model: string | null): void {
    this.update(serverUrl, userId, connectorId, runtimeId, model, null, true);
  }

  savePermission(serverUrl: string, userId: string, connectorId: string, runtimeId: string,
    permission: string | null): void {
    this.update(serverUrl, userId, connectorId, runtimeId, null, permission, true);
  }

  private update(serverUrl: string, userId: string, connectorId: string, runtimeId: string,
    model: string | null, permission: string | null, keepOtherSelection: boolean): void {
    const key = this.storageKey(serverUrl, userId);
    if (key === null || connectorId.length === 0 || runtimeId.length === 0) {
      return;
    }
    const previous = this.readPreference(serverUrl, userId);
    const selections: NewSessionStoredSelection[] = [];
    let existing: NewSessionStoredSelection | null = null;
    if (previous !== null) {
      for (const entry of previous.selections) {
        if (entry.connectorId === connectorId && entry.runtimeId === runtimeId) {
          existing = entry;
        } else {
          selections.push(entry);
        }
      }
    }
    const nextModel = model !== null ? model : (keepOtherSelection && existing !== null ? existing.model : null);
    const nextPermission = permission !== null ? permission :
      (keepOtherSelection && existing !== null ? existing.permission : null);
    if (nextModel !== null || nextPermission !== null) {
      const entry: NewSessionStoredSelection = {
        connectorId: connectorId,
        runtimeId: runtimeId,
        model: nextModel,
        permission: nextPermission
      };
      selections.push(entry);
    }
    const preference: NewSessionPreference = {
      connectorId: connectorId,
      runtimeId: runtimeId,
      selections: selections
    };
    this.putString(key, JSON.stringify(preference));
  }

  private decodePreference(raw: string): NewSessionPreference | null {
    if (raw.trim().length === 0) {
      return null;
    }
    let source: Record<string, Object>;
    try {
      source = parseJsonRecord(raw);
    } catch (error) {
      return null;
    }
    const connectorId = objGetOptString(source, 'connectorId');
    const runtimeId = objGetOptString(source, 'runtimeId');
    if (connectorId === null || runtimeId === null) {
      return null;
    }
    const selections: NewSessionStoredSelection[] = [];
    for (const value of objGetArray(source, 'selections')) {
      const record = recordOrNull(value);
      if (record === null) {
        continue;
      }
      const entryConnectorId = objGetOptString(record, 'connectorId');
      const entryRuntimeId = objGetOptString(record, 'runtimeId');
      if (entryConnectorId === null || entryRuntimeId === null) {
        continue;
      }
      const model = objGetOptString(record, 'model');
      const permission = objGetOptString(record, 'permission');
      if (model === null && permission === null) {
        continue;
      }
      const entry: NewSessionStoredSelection = {
        connectorId: entryConnectorId,
        runtimeId: entryRuntimeId,
        model: model,
        permission: permission
      };
      selections.push(entry);
    }
    const preference: NewSessionPreference = {
      connectorId: connectorId,
      runtimeId: runtimeId,
      selections: selections
    };
    return preference;
  }

  private requireStore(): preferences.Preferences {
    const store = this.store;
    if (store === null) {
      if (this.initError.length > 0) {
        throw new Error(`New session storage failed to initialize: ${this.initError}`);
      }
      throw new Error('New session storage is not ready yet.');
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

  private putString(key: string, value: string): void {
    const store = this.requireStore();
    store.putSync(key, value);
    store.flush().catch(() => {
    });
  }
}
