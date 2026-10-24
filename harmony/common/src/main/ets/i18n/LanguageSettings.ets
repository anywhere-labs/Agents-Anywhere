/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/**
 * User-facing language choice for the app.
 * - 'system': follow the OS language (no app-level override).
 * - 'zh_CN' : force Simplified Chinese.
 * - 'en'    : force English.
 */
export type AppLanguageMode = 'system' | 'zh_CN' | 'en';

export const APP_LANGUAGE_KEY: string = 'appLanguage';
const PREF_NAME: string = 'app-language';
const LOG_TAG: string = 'AgentsAnywhere.Language';
// Applying a new preferred language re-renders the whole visible page tree.
// Deferring the system call lets the row-tap feedback finish its frame first.
const INTERACTIVE_APPLY_DELAY_MS: number = 300;

export class LanguageSettings {
  private static instance: LanguageSettings | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  // Locale last pushed to the system; guards against the re-entrant chain
  // setAppPreferredLanguage -> onConfigurationUpdate -> loadAndApply ->
  // setAppPreferredLanguage, which caused repeated full-tree re-renders.
  private lastAppliedLocale: string | null = null;

  static getInstance(): LanguageSettings {
    if (LanguageSettings.instance === null) {
      LanguageSettings.instance = new LanguageSettings();
    }
    return LanguageSettings.instance;
  }

  init(context: Context): void {
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

  private async readStored(): Promise<AppLanguageMode> {
    const store = this.store;
    if (store === null) {
      return 'system';
    }
    try {
      const value = await store.get(APP_LANGUAGE_KEY, 'system');
      if (value === 'zh_CN' || value === 'en' || value === 'system') {
        return value;
      }
    } catch (err) {
      // Fall through to the default.
    }
    return 'system';
  }

  /**
   * Read the persisted choice and apply it to both AppStorage and the OS-level
   * app preferred language. Called from EntryAbility.onCreate.
   */
  async loadAndApply(): Promise<void> {
    const mode: AppLanguageMode = await this.readStored();
    AppStorage.setOrCreate<string>(APP_LANGUAGE_KEY, mode);
    this.applyToSystem(mode);
  }

  /**
   * Persist a new choice and apply it. The persisted value and AppStorage are
   * updated immediately so the selected row reacts in the same frame; only the
   * system-level apply is deferred. Called from the Profile language switcher.
   */
  async setLanguage(mode: AppLanguageMode): Promise<AppLanguageMode> {
    const store = this.store;
    if (store !== null) {
      try {
        await store.put(APP_LANGUAGE_KEY, mode);
        await store.flush();
      } catch (err) {
        hilog.error(0x0000, LOG_TAG, 'Failed to persist language: %{public}s',
          (err as Error).message);
      }
    }
    AppStorage.setOrCreate<string>(APP_LANGUAGE_KEY, mode);
    this.applyToSystem(mode, INTERACTIVE_APPLY_DELAY_MS);
    return mode;
  }

  /**
   * Push the choice to the HarmonyOS i18n subsystem so that qualifier-based
   * string resources resolve to the right language bundle.
   * Passing 'default' clears the override and lets the system language win.
   * Already-applied locales are skipped to avoid redundant configuration
   * changes and their full-tree re-renders.
   */
  private applyToSystem(mode: AppLanguageMode, delayMs: number = 0): void {
    let locale: string = 'default';
    if (mode === 'zh_CN') {
      locale = 'zh-CN';
    } else if (mode === 'en') {
      locale = 'en';
    }
    if (this.lastAppliedLocale === locale) {
      return;
    }
    this.lastAppliedLocale = locale;
    const apply = (): void => {
      try {
        i18n.System.setAppPreferredLanguage(locale);
      } catch (err) {
        // Undo the guard so a later attempt can retry.
        this.lastAppliedLocale = null;
        hilog.error(0x0000, LOG_TAG, 'setAppPreferredLanguage failed: %{public}s',
          (err as Error).message);
      }
    };
    if (delayMs > 0) {
      setTimeout(apply, delayMs);
    } else {
      apply();
    }
  }
}
