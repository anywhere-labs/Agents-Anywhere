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

/**
 * Design-system color tokens for the HarmonyOS client.
 *
 * Token naming/semantics mirror `android/ui/designsystem/Theme.kt`
 * (AgentsAnywhereColors). Every token that exists in the Android scheme
 * carries the exact Android value in both themes; tokens that only exist
 * on HarmonyOS follow the closest Android scene (file references are kept
 * in the token report).
 *
 * Every token is a plain `string` (a `#RRGGBB` or `#AARRGGBB` literal) so
 * it can be passed directly to ArkUI style methods such as
 * `.backgroundColor(...)`, `.fontColor(...)`, `.fill(...)` or
 * `.stroke(...)`.
 */

export interface ColorSet {
  // Base surfaces
  canvas: string;
  headingText: string;
  ink: string;
  inkSoft: string;
  muted: string;
  faint: string;
  border: string;
  subtle: string;
  subtleSurface: string;
  raisedSurface: string;
  dialogSurface: string;
  onRaisedSurface: string;

  // Actions
  primaryAction: string;
  onPrimaryAction: string;
  secondaryActionSurface: string;
  secondaryActionBorder: string;
  matchedAccountSurface: string;

  // Errors
  errorSurface: string;
  errorBorder: string;
  errorText: string;
  errorIcon: string;

  // Runtime / connector status
  runtimeRunning: string;
  runtimeTransitioning: string;
  runtimeActive: string;
  runtimeInactive: string;
  runtimeSwitchCheckedTrack: string;
  runtimeSwitchUncheckedTrack: string;
  runtimeSwitchCheckedThumb: string;
  runtimeSwitchUncheckedThumb: string;

  // Session status
  sessionStatusAccent: string;
  sessionStatusAccentText: string;
  noticeWarning: string;
  noticeSuccess: string;
  sessionMessageBubble: string;
  sessionMessageText: string;
  sessionTimelineActivitySurface: string;
  sessionCodeSurface: string;
  sessionStatusNeutralSurface: string;
  sessionStatusNeutralText: string;

  // Misc
  appShadow: string;

  // Harmony-specific accent surfaces (low-alpha accent tints, following the
  // Android pattern of tinting surfaces with semantic accent colors)
  accentSurface: string;
  successSurface: string;
  successBorder: string;
  warningSurface: string;
  warningBorder: string;
  accentPurple: string;
  accentPurpleSurface: string;

  // Markdown renderer tokens (per-bubble, theme-aware)
  mdLinkOnPrimary: string;
  mdInlineOnPrimary: string;
  mdCodeOnPrimary: string;
  mdCodePanelText: string;
  mdInlineOnSurface: string;
  mdCodeOnSurface: string;

  // Diff code view tokens
  diffAddedSurface: string;
  diffAddedText: string;
  diffRemovedSurface: string;
  diffRemovedText: string;
  diffContextText: string;
  diffHunkHeaderSurface: string;
  diffHunkHeaderText: string;

  // Terminal screen colors (aligned with the Android terminal emulator)
  terminalBackground: string;
  terminalText: string;
}

export const LightColors: ColorSet = {
  canvas: '#FDFCFB',
  headingText: '#0A0A0B',
  ink: '#0A0A0B',
  inkSoft: '#2B2B2B',
  muted: '#777777',
  faint: '#AAA8A2',
  border: '#E7E5E0',
  subtle: '#F1F0ED',
  subtleSurface: '#F1F0ED',
  raisedSurface: '#FFFFFF',
  dialogSurface: '#FFFFFF',
  onRaisedSurface: '#111111',

  primaryAction: '#0A0A0B',
  onPrimaryAction: '#FFFFFF',
  secondaryActionSurface: '#F3F3F3',
  secondaryActionBorder: '#0A0A0B',
  matchedAccountSurface: '#F6F6F3',

  errorSurface: '#FFF4F4',
  errorBorder: '#F4C7C7',
  errorText: '#B42318',
  errorIcon: '#B42318',

  runtimeRunning: '#10B981',
  runtimeTransitioning: '#3B82F6',
  runtimeActive: '#F59E0B',
  runtimeInactive: '#66777777',
  runtimeSwitchCheckedTrack: '#171717',
  runtimeSwitchUncheckedTrack: '#E5E5E5',
  runtimeSwitchCheckedThumb: '#FFFFFF',
  runtimeSwitchUncheckedThumb: '#FFFFFF',

  sessionStatusAccent: '#18866A',
  sessionStatusAccentText: '#146B56',
  noticeWarning: '#D97706',
  noticeSuccess: '#16A34A',
  sessionMessageBubble: '#F1F0ED',
  sessionMessageText: '#242522',
  sessionTimelineActivitySurface: '#14F1F0ED',
  sessionCodeSurface: '#B8FFFFFF',
  sessionStatusNeutralSurface: '#E4E2DD',
  sessionStatusNeutralText: '#6F6E69',

  appShadow: '#22000000',

  accentSurface: '#0D0A0A0B',
  successSurface: '#0D16A34A',
  successBorder: '#5216A34A',
  warningSurface: '#0DD97706',
  warningBorder: '#52D97706',
  accentPurple: '#7C3AED',
  accentPurpleSurface: '#EDE9FE',

  mdLinkOnPrimary: '#EBB353',
  mdInlineOnPrimary: '#FFFFFF',
  mdCodeOnPrimary: '#ECECEA',
  mdCodePanelText: '#333333',
  mdInlineOnSurface: '#242522',
  mdCodeOnSurface: '#ECECEA',

  diffAddedSurface: '#DDF8E7',
  diffAddedText: '#333333',
  diffRemovedSurface: '#FFE1E1',
  diffRemovedText: '#333333',
  diffContextText: '#333333',
  diffHunkHeaderSurface: '#B8FFFFFF',
  diffHunkHeaderText: '#333333',

  terminalBackground: '#FEFDFB',
  terminalText: '#20211E'
};

export const DarkColors: ColorSet = {
  canvas: '#09090B',
  headingText: '#FAFAFA',
  ink: '#FAFAFA',
  inkSoft: '#E5E5E5',
  muted: '#A3A3A3',
  faint: '#737373',
  border: '#00000000',
  subtle: '#292929',
  subtleSurface: '#292929',
  raisedSurface: '#1F1F1F',
  dialogSurface: '#242424',
  onRaisedSurface: '#FAFAFA',

  primaryAction: '#FAFAFA',
  onPrimaryAction: '#09090B',
  secondaryActionSurface: '#424242',
  secondaryActionBorder: '#00000000',
  matchedAccountSurface: '#191919',

  errorSurface: '#2A1214',
  errorBorder: '#5F2429',
  errorText: '#FCA5A5',
  errorIcon: '#F97066',

  runtimeRunning: '#10B981',
  runtimeTransitioning: '#3B82F6',
  runtimeActive: '#F59E0B',
  runtimeInactive: '#66A1A1AA',
  runtimeSwitchCheckedTrack: '#E5E5E5',
  runtimeSwitchUncheckedTrack: '#26FFFFFF',
  runtimeSwitchCheckedThumb: '#171717',
  runtimeSwitchUncheckedThumb: '#FAFAFA',

  sessionStatusAccent: '#39A887',
  sessionStatusAccentText: '#65C4A6',
  noticeWarning: '#F59E0B',
  noticeSuccess: '#22C55E',
  sessionMessageBubble: '#2A2A2A',
  sessionMessageText: '#F4F4F5',
  sessionTimelineActivitySurface: '#1018181B',
  sessionCodeSurface: '#111113',
  sessionStatusNeutralSurface: '#2D2D2D',
  sessionStatusNeutralText: '#D4D4D8',

  appShadow: '#52000000',

  accentSurface: '#0DFAFAFA',
  successSurface: '#0D22C55E',
  successBorder: '#5222C55E',
  warningSurface: '#0DF59E0B',
  warningBorder: '#52F59E0B',
  accentPurple: '#A78BFA',
  accentPurpleSurface: '#3B2F63',

  mdLinkOnPrimary: '#EBB353',
  mdInlineOnPrimary: '#09090B',
  mdCodeOnPrimary: '#1F1F1F',
  mdCodePanelText: '#CCCCCC',
  mdInlineOnSurface: '#EDEDEF',
  mdCodeOnSurface: '#1F1F1F',

  diffAddedSurface: '#163820',
  diffAddedText: '#CCCCCC',
  diffRemovedSurface: '#411C1C',
  diffRemovedText: '#CCCCCC',
  diffContextText: '#CCCCCC',
  diffHunkHeaderSurface: '#111113',
  diffHunkHeaderText: '#CCCCCC',

  terminalBackground: '#09090B',
  terminalText: '#FAFAFA'
};

export type AppAppearanceMode = 'system' | 'light' | 'dark';

/**
 * AppStorage keys shared with the UIAbility layer.
 * - `appMode`: the user's chosen appearance ('system' | 'light' | 'dark').
 * - `appIsDark`: the *resolved* effective dark state (always kept in sync by
 *   EntryAbility, including when following the system theme).
 */
export const APP_MODE_KEY: string = 'appMode';
export const APP_IS_DARK_KEY: string = 'appIsDark';

/**
 * Returns the color set for the currently active theme.
 *
 * In `system` mode it re-reads the resolved `appIsDark` flag that
 * EntryAbility maintains, so it always reflects the real system theme.
 *
 * To make a page re-render when the theme changes, the page must subscribe to
 * the `appIsDark` key (e.g. `@StorageLink(APP_IS_DARK_KEY) themeIsDark: boolean
 * = false;`). The subscription (not the call itself) is what triggers the
 * re-render; `getColors()` simply returns the correct set on each rebuild.
 */
export function getColors(): ColorSet {
  let mode: AppAppearanceMode = 'system';
  try {
    const stored = AppStorage.get<string>(APP_MODE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      mode = stored;
    }
  } catch (err) {
    // AppStorage unavailable; fall back to system resolution below.
  }

  let isDark: boolean = false;
  try {
    const stored = AppStorage.get<boolean>(APP_IS_DARK_KEY);
    if (typeof stored === 'boolean') {
      isDark = stored;
    }
  } catch (err) {
    // Keep default (false).
  }

  if (mode === 'dark') {
    isDark = true;
  } else if (mode === 'light') {
    isDark = false;
  }

  return isDark ? DarkColors : LightColors;
}
