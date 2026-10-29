import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const STORE_NAME = 'app-updates';
const LOG_TAG = 'AgentsAnywhere.AppUpdates';

export class AppUpdateIgnoreStore {
  private static instance: AppUpdateIgnoreStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  private initError: string = '';

  static getInstance(): AppUpdateIgnoreStore {
    if (AppUpdateIgnoreStore.instance === null) {
      AppUpdateIgnoreStore.instance = new AppUpdateIgnoreStore();
    }
    return AppUpdateIgnoreStore.instance;
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

  async waitUntilReady(): Promise<void> {
    const promise = this.readyPromise;
    if (promise !== null) {
      await promise;
    }
  }

  readIgnoredVersion(serverUrl: string): string {
    const store = this.requireStore();
    const value = store.getSync(this.ignoredKey(serverUrl), '');
    if (typeof value !== 'string') {
      return '';
    }
    return value;
  }

  saveIgnoredVersion(serverUrl: string, versionName: string): void {
    const store = this.requireStore();
    store.putSync(this.ignoredKey(serverUrl), versionName);
    store.flush().catch(() => {
    });
  }

  private ignoredKey(serverUrl: string): string {
    return `ignored:${serverUrl}`;
  }

  private requireStore(): preferences.Preferences {
    const store = this.store;
    if (store === null) {
      if (this.initError.length > 0) {
        throw new Error(`App update storage failed to initialize: ${this.initError}`);
      }
      throw new Error('App update storage is not ready yet.');
    }
    return store;
  }
}
