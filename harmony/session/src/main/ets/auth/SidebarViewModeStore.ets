import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const STORE_NAME = 'agents_anywhere_sidebar_view';
const LOG_TAG = 'AgentsAnywhere.SidebarView';

// AppStorage key holding the current sidebar view mode ('project' | 'session').
export const SIDEBAR_VIEW_MODE_KEY = 'appSidebarViewMode';
export const SIDEBAR_VIEW_PROJECT = 'project';
export const SIDEBAR_VIEW_SESSION = 'session';

// Mirrors Android HomeSidebarViewMode + MainActivity KEY_SIDEBAR_VIEW_MODE:
// 'project' by default, persisted globally (not per account).
export class SidebarViewModeStore {
  private static instance: SidebarViewModeStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;

  static getInstance(): SidebarViewModeStore {
    if (SidebarViewModeStore.instance === null) {
      SidebarViewModeStore.instance = new SidebarViewModeStore();
    }
    return SidebarViewModeStore.instance;
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
        hilog.error(0x0000, LOG_TAG, `getPreferences("${STORE_NAME}") failed: ${error.message}`);
      });
  }

  waitUntilReady(): Promise<void> {
    if (this.readyPromise !== null) {
      return this.readyPromise;
    }
    return Promise.resolve();
  }

  // Mirrors Android HomeSidebarViewMode.normalize: anything other than
  // 'session' falls back to 'project'.
  normalize(value: string): string {
    return value === SIDEBAR_VIEW_SESSION ? SIDEBAR_VIEW_SESSION : SIDEBAR_VIEW_PROJECT;
  }

  async loadAndApply(): Promise<void> {
    await this.waitUntilReady();
    let mode = SIDEBAR_VIEW_PROJECT;
    const store = this.store;
    if (store !== null) {
      try {
        const value = store.getSync(SIDEBAR_VIEW_MODE_KEY, SIDEBAR_VIEW_PROJECT);
        if (typeof value === 'string') {
          mode = this.normalize(value);
        }
      } catch (error) {
        const err = error as BusinessError;
        hilog.error(0x0000, LOG_TAG, `read sidebar view mode failed: ${err.message}`);
      }
    }
    AppStorage.setOrCreate<string>(SIDEBAR_VIEW_MODE_KEY, mode);
  }

  async setMode(mode: string): Promise<void> {
    const normalized = this.normalize(mode);
    const store = this.store;
    if (store !== null) {
      try {
        await store.put(SIDEBAR_VIEW_MODE_KEY, normalized);
        await store.flush();
      } catch (error) {
        const err = error as BusinessError;
        hilog.error(0x0000, LOG_TAG, `persist sidebar view mode failed: ${err.message}`);
      }
    }
    AppStorage.setOrCreate<string>(SIDEBAR_VIEW_MODE_KEY, normalized);
  }
}
