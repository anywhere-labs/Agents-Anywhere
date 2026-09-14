/**
 * Design tokens ported 1:1 from the Android client.
 *
 * Source of truth: android/app/src/main/java/com/agentsanywhere/app/ui/designsystem/Theme.kt
 * (`AgentsAnywhereColors`, light and dark instances).
 *
 * Every value is a `#AARRGGBB` string because ArkUI parses that form directly,
 * which keeps the translucent Android tokens (for example the 0x14F1F0ED
 * timeline activity surface) expressible without a separate alpha channel.
 *
 * Do not invent tokens here. If a screen needs a colour that Android derives
 * from `MaterialTheme`, derive it the same way at the call site instead.
 */
export interface AAColors {
  isDark: boolean;
  canvas: string;
  ink: string;
  inkSoft: string;
  muted: string;
  faint: string;
  border: string;
  subtle: string;
  raisedSurface: string;
  dialogSurface: string;
  onRaisedSurface: string;
  primaryAction: string;
  onPrimaryAction: string;
  secondaryActionSurface: string;
  secondaryActionBorder: string;
  matchedAccountSurface: string;
  errorSurface: string;
  errorBorder: string;
  errorText: string;
  errorIcon: string;
  runtimeRunning: string;
  runtimeTransitioning: string;
  runtimeActive: string;
  runtimeInactive: string;
  runtimeSwitchCheckedTrack: string;
  runtimeSwitchUncheckedTrack: string;
  runtimeSwitchCheckedThumb: string;
  runtimeSwitchUncheckedThumb: string;
  sessionStatusAccent: string;
  sessionStatusAccentText: string;
  noticeWarning: string;
  noticeSuccess: string;
  sessionMessageBubble: string;
  sessionMessageText: string;
  /**
   * Android's grouped-activity tint. Kept so the palette still mirrors
   * `Theme.kt` one-for-one; the iOS timeline rows carry no surface of their own,
   * so nothing reads it any more (round 40).
   */
  sessionTimelineActivitySurface: string;
  sessionCodeSurface: string;
  sessionStatusNeutralSurface: string;
  sessionStatusNeutralText: string;
  appShadow: string;
}

/** Android `Color.Transparent`, kept as a token so dark-mode borders stay explicit. */
export const AA_TRANSPARENT: string = '#00000000';

export const AA_LIGHT_COLORS: AAColors = {
  isDark: false,
  canvas: '#FDFCFB',
  ink: '#0A0A0B',
  inkSoft: '#2B2B2B',
  muted: '#777777',
  faint: '#AAA8A2',
  border: '#E7E5E0',
  subtle: '#F1F0ED',
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
};

export const AA_DARK_COLORS: AAColors = {
  isDark: true,
  canvas: '#09090B',
  ink: '#FAFAFA',
  inkSoft: '#E5E5E5',
  muted: '#A3A3A3',
  faint: '#737373',
  // Android uses Color.Transparent here, so all 1dp borders disappear in dark mode.
  border: AA_TRANSPARENT,
  subtle: '#292929',
  raisedSurface: '#1F1F1F',
  dialogSurface: '#242424',
  onRaisedSurface: '#FAFAFA',
  primaryAction: '#FAFAFA',
  onPrimaryAction: '#09090B',
  secondaryActionSurface: '#424242',
  secondaryActionBorder: AA_TRANSPARENT,
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
};

/** Appearance mode values, byte-identical to `AAAppearanceMode` on Android. */
export class AAAppearanceMode {
  static readonly SYSTEM: string = 'system';
  static readonly LIGHT: string = 'light';
  static readonly DARK: string = 'dark';
}

/** Language mode values, byte-identical to `AALanguageMode` on Android. */
export class AALanguageMode {
  static readonly SYSTEM: string = 'system';
  static readonly ENGLISH: string = 'en';
  static readonly SIMPLIFIED_CHINESE: string = 'zh-CN';
}

/**
 * Applies an alpha to a `#RRGGBB` token, producing `#AARRGGBB`.
 *
 * Android uses `Color.copy(alpha = …)` for surface tints such as the destructive
 * notice background. ArkUI colours are strings, so the alpha channel is prefixed
 * instead. An input that already carries alpha is treated as `#RRGGBB` only when
 * it has six digits; otherwise it is returned unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#') || color.length !== 7) {
    return color;
  }
  const clamped: number = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
  const channel: number = Math.round(clamped * 255);
  const hex: string = channel.toString(16).padStart(2, '0').toUpperCase();
  return `#${hex}${color.substring(1)}`;
}

/**
 * Composites a translucent colour over an opaque background.
 *
 * Android's bottom sheet derives its secondary text colour with
 * `inkSoft.copy(alpha = 0.8f).compositeOver(raisedSurface)`; ArkUI has no
 * equivalent operator, so the blend is done here channel by channel. Both inputs
 * accept `#RRGGBB` or `#AARRGGBB`, and an unparseable input is returned unchanged
 * so a bad token degrades to a visible colour rather than to nothing.
 */
export function compositeOverAlpha(color: string, alpha: number, background: string): string {
  if (!color.startsWith('#') || !background.startsWith('#')) {
    return color;
  }
  const foreground: string = color.substring(1);
  const behind: string = background.substring(1);
  const foregroundValid: boolean = foreground.length === 6 || foreground.length === 8;
  const behindValid: boolean = behind.length === 6 || behind.length === 8;
  if (!foregroundValid || !behindValid) {
    return color;
  }
  const foregroundOffset: number = foreground.length === 8 ? 2 : 0;
  const behindOffset: number = behind.length === 8 ? 2 : 0;
  const ownAlpha: number = foreground.length === 8
    ? parseInt(foreground.substring(0, 2), 16) / 255
    : 1;
  const clamped: number = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
  const foregroundAlpha: number = ownAlpha * clamped;
  const behindAlpha: number = behind.length === 8
    ? parseInt(behind.substring(0, 2), 16) / 255
    : 1;
  const outAlpha: number = foregroundAlpha + behindAlpha * (1 - foregroundAlpha);
  const channels: string[] = [];
  for (let index = 0; index < 3; index++) {
    const start: number = index * 2;
    const front: number = parseInt(foreground.substring(foregroundOffset + start, foregroundOffset + start + 2), 16);
    const back: number = parseInt(behind.substring(behindOffset + start, behindOffset + start + 2), 16);
    const blended: number = outAlpha <= 0
      ? 0
      : Math.round((front * foregroundAlpha + back * behindAlpha * (1 - foregroundAlpha)) / outAlpha);
    channels.push(blended.toString(16).padStart(2, '0').toUpperCase());
  }
  if (outAlpha >= 0.999) {
    return `#${channels.join('')}`;
  }
  const alphaHex: string = Math.round(outAlpha * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${alphaHex}${channels.join('')}`;
}

/**
 * Resolves the active palette. `appearanceMode` is the stored preference and
 * `systemDark` is the current system scheme, mirroring Android's
 * `isSystemInDarkTheme()` fallback for the `system` mode.
 */
export function resolveAAColors(appearanceMode: string, systemDark: boolean): AAColors {
  if (appearanceMode === AAAppearanceMode.LIGHT) {
    return AA_LIGHT_COLORS;
  }
  if (appearanceMode === AAAppearanceMode.DARK) {
    return AA_DARK_COLORS;
  }
  return systemDark ? AA_DARK_COLORS : AA_LIGHT_COLORS;
}
