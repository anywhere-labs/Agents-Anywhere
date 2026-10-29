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

import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { AuthSessionStore } from 'session';
import { AnnouncementReadStore } from 'session';
import { AppUpdateIgnoreStore } from 'session';
import { NewSessionPreferenceStore } from 'session';
import { SidebarViewModeStore } from 'session';
import { ComposerDraftStore } from 'session';
import { APP_IS_DARK_KEY, APP_MODE_KEY } from 'common';
import { AppearanceSettings } from 'common';
import { LanguageSettings } from 'common';

const DOMAIN = 0x0000;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      // Keep the OS-level color mode following the system (NOT_SET). The actual
      // light/dark decision for our design tokens is resolved through AppStorage.
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    // Initialize the design-system theme state. Default to following the system.
    AppStorage.setOrCreate<string>(APP_MODE_KEY, 'system');
    AppStorage.setOrCreate<boolean>(APP_IS_DARK_KEY, this.resolveIsDark());
    // Load the persisted appearance preference and apply it (may switch the
    // app-level color mode when the user chose light/dark explicitly).
    AppearanceSettings.getInstance().init(this.context);
    AppearanceSettings.getInstance().loadAndApply();
    // Initialize the user language preference and apply it to the i18n subsystem.
    LanguageSettings.getInstance().init(this.context);
    LanguageSettings.getInstance().loadAndApply();
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');
  }

  // Resolve the *effective* dark state from the system configuration. This is the
  // value used by getColors() when appMode is 'system'.
  private resolveIsDark(): boolean {
    try {
      const mode = this.context.config.colorMode;
      if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
        return true;
      }
      if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT) {
        return false;
      }
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to read colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    return false;
  }

  // Push the resolved dark state into AppStorage so subscribed pages re-render.
  // NOTE: do not re-run AppearanceSettings.loadAndApply() here — it calls
  // setColorMode(), which triggers onConfigurationUpdate(), which calls this
  // method again: a feedback loop that can block the main thread (appfreeze).
  private syncTheme(): void {
    try {
      const mode = AppStorage.get<string>(APP_MODE_KEY);
      if (mode !== 'light' && mode !== 'dark') {
        AppStorage.setOrCreate<boolean>(APP_IS_DARK_KEY, this.resolveIsDark());
      }
    } catch (err) {
      // Leave the stored value untouched if AppStorage is unavailable.
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageCreate');

    AuthSessionStore.getInstance().init(this.context);
    AnnouncementReadStore.getInstance().init(this.context);
    AppUpdateIgnoreStore.getInstance().init(this.context);
    NewSessionPreferenceStore.getInstance().init(this.context);
    SidebarViewModeStore.getInstance().init(this.context);
    ComposerDraftStore.getInstance().init(this.context);
    SidebarViewModeStore.getInstance().loadAndApply();
    // Ensure the resolved theme flag matches the system when following it.
    this.syncTheme();
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
    });
  }

  // Re-sync the effective dark state whenever the system configuration (e.g. the
  // OS dark-mode setting) changes. Pages subscribed to APP_IS_DARK_KEY re-render.
  onConfigurationUpdate(newConfig: Configuration): void {
    this.syncTheme();
    // Re-apply the language preference (a no-op when following the system, which
    // already re-resolves qualifier resources on its own).
    LanguageSettings.getInstance().loadAndApply();
  }

  onWindowStageDestroy(): void {
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onBackground');
  }
}