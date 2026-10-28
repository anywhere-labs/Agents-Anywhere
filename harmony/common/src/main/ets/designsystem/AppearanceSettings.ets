import { preferences } from '@kit.ArkData';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { APP_IS_DARK_KEY, APP_MODE_KEY, AppAppearanceMode } from './ColorTokens';

const PREF_NAME: string = 'app-appearance';
const LOG_TAG: string = 'AgentsAnywhere.Appearance';

export class AppearanceSettings {
  private static instance: AppearanceSettings | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  private abilityContext: common.UIAbilityContext | null = null;
  private lastAppliedMode: AppAppearanceMode | null = null;

  static getInstance(): AppearanceSettings {
    if (AppearanceSettings.instance === null) {
      AppearanceSettings.instance = new AppearanceSettings();
    }
    return AppearanceSettings.instance;
  }

  init(context: common.UIAbilityContext): void {
    this.abilityContext = context;
    if (this.readyPromise !== null) {
      return;
    }
    this.readyPromise = preferences.getPreferences(context, { name: PREF_NAME })
      .then((value: preferences.Preferences) => {
        this.store = value;
      })
      .catch((error: Error) => {
        hilog.error(0x0000, LOG_TAG, 'getPreferences failed: %{public}s', error.message);
      });
  }

  async waitUntilReady(): Promise<void> {
    const promise = this.readyPromise;
    if (promise !== null) {
      await promise;
    }
  }

  async loadAndApply(): Promise<void> {
    await this.waitUntilReady();
    const store = this.store;
    if (store === null) {
      return;
    }
    let mode: AppAppearanceMode = 'system';
    try {
      const value = store.getSync(APP_MODE_KEY, 'system');
      if (value === 'light' || value === 'dark' || value === 'system') {
        mode = value;
      }
    } catch (err) {
      hilog.error(0x0000, LOG_TAG, 'read appearance failed: %{public}s', (err as Error).message);
    }
    this.applyMode(mode);
  }

  async setMode(mode: AppAppearanceMode): Promise<void> {
    const store = this.store;
    if (store !== null) {
      try {
        await store.put(APP_MODE_KEY, mode);
        await store.flush();
      } catch (err) {
        hilog.error(0x0000, LOG_TAG, 'Failed to persist appearance: %{public}s', (err as Error).message);
      }
    }
    this.applyMode(mode);
  }

  private applyMode(mode: AppAppearanceMode): void {
    AppStorage.setOrCreate<string>(APP_MODE_KEY, mode);
    this.applySystemColorMode(mode);
    this.lastAppliedMode = mode;
    if (mode === 'dark') {
      AppStorage.setOrCreate<boolean>(APP_IS_DARK_KEY, true);
    } else if (mode === 'light') {
      AppStorage.setOrCreate<boolean>(APP_IS_DARK_KEY, false);
    } else {
      AppStorage.setOrCreate<boolean>(APP_IS_DARK_KEY, this.resolveSystemDark());
    }
  }

  // Keep the OS-level color mode in sync with the in-app choice so the status
  // bar, navigation bar, system dialogs and pickers follow the same theme as
  // the design tokens. 'system' defers back to the OS setting. Repeated
  // requests for the same mode are skipped: each real transition triggers a
  // synchronous OnConfigurationUpdated chain on the main thread.
  private applySystemColorMode(mode: AppAppearanceMode): void {
    const context = this.abilityContext;
    if (context === null) {
      return;
    }
    if (this.lastAppliedMode === mode) {
      return;
    }
    try {
      const appContext = context.getApplicationContext();
      if (mode === 'dark') {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
      } else if (mode === 'light') {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
      } else {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
      }
    } catch (err) {
      hilog.error(0x0000, LOG_TAG, 'Failed to apply color mode: %{public}s', (err as Error).message);
    }
  }

  private resolveSystemDark(): boolean {
    const context = this.abilityContext;
    if (context === null) {
      return false;
    }
    try {
      const mode = context.config.colorMode;
      if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
        return true;
      }
    } catch (err) {
      hilog.error(0x0000, LOG_TAG, 'Failed to read colorMode.');
    }
    return false;
  }
}
