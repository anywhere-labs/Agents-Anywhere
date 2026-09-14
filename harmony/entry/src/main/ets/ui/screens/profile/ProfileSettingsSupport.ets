import { AAColors } from '../../designsystem/AAColors';
import { ParsedAuthMe } from '../../../api/AuthDtos';
import { base64Encode } from '../../../common/AAEncoding';
import { loadLocalThumbnail } from '../../../common/AAImages';
import { AALog } from '../../../common/AAAppLog';
import { image } from '@kit.ImageKit';
import { resolveString } from '../../../common/AAResources';

/**
 * Labels and surfaces for the settings drawer.
 *
 * Port of `ui/screens/profile/ProfileSettingsSupport.kt` and the colour helpers
 * at the bottom of `ProfileSettingsComponents.kt`.
 *
 * The four surfaces differ from the shared tokens on purpose: the drawer sits on
 * a slightly warmer canvas, and its cards are pure white on light while every
 * other screen uses the raised surface.
 */

/** Android's `AAAppearanceMode`: `system`, `light`, `dark`. */
export class AAAppearanceMode {
  static readonly SYSTEM: string = 'system';
  static readonly LIGHT: string = 'light';
  static readonly DARK: string = 'dark';
}

/** Android's `AALanguageMode`: `system`, `en`, `zh-Hans`. */
export class AALanguageMode {
  static readonly SYSTEM: string = 'system';
  static readonly ENGLISH: string = 'en';
  static readonly SIMPLIFIED_CHINESE: string = 'zh-Hans';
}

export function labelForAppearance(mode: string): ResourceStr {
  if (mode === AAAppearanceMode.LIGHT) {
    return $r('app.string.profile_light');
  }
  if (mode === AAAppearanceMode.DARK) {
    return $r('app.string.profile_dark');
  }
  return $r('app.string.profile_system');
}

export function labelForLanguage(mode: string): ResourceStr {
  if (mode === AALanguageMode.ENGLISH) {
    return $r('app.string.profile_english');
  }
  if (mode === AALanguageMode.SIMPLIFIED_CHINESE) {
    return $r('app.string.profile_simplified_chinese');
  }
  return $r('app.string.profile_language_follow_system');
}

export function labelForSidebarView(mode: string): ResourceStr {
  if (mode === 'session') {
    return $r('app.string.profile_session_view');
  }
  return $r('app.string.profile_project_view');
}

/**
 * The role as the account page shows it.
 *
 * Android capitalises an unknown role instead of hiding it, so a Server that
 * invents a role still renders something sensible.
 */
export function prettyRole(role: string): string {
  const lower: string = role.toLowerCase();
  if (lower === 'admin') {
    return resolveString($r('app.string.profile_role_admin'));
  }
  if (lower === 'member') {
    return resolveString($r('app.string.profile_role_member'));
  }
  if (role.length === 0) {
    return '';
  }
  return role.charAt(0).toUpperCase() + role.substring(1);
}

/** Android's `AuthMeResponse.accountLabel`. */
export function accountLabel(account: ParsedAuthMe): string {
  if (account.displayName.trim().length > 0) {
    return account.displayName;
  }
  return account.email === null ? '' : account.email;
}

export function isProfileDark(colors: AAColors): boolean {
  return colors.isDark;
}

export function profilePageBackground(colors: AAColors): string {
  return colors.isDark ? colors.canvas : '#F4F3EF';
}

export function profileCardBackground(colors: AAColors): string {
  return colors.isDark ? colors.raisedSurface : '#FFFFFF';
}

export function profileDividerColor(colors: AAColors): string {
  return colors.isDark ? colors.border : '#E7E5DF';
}

/**
 * The picked image as a PNG data URL, capped at 256px.
 *
 * Port of `ProfileSettingsSupport.kt`'s `avatarDataUrl`: the Server stores the
 * avatar inline, so the client scales the picture down before sending it. A
 * picture that cannot be decoded reads as `null`, which the caller reports as a
 * read failure.
 */
export async function avatarDataUrl(uri: string): Promise<string | null> {
  const pixelMap: image.PixelMap | null = await loadLocalThumbnail(uri, 256);
  if (pixelMap === null) {
    return null;
  }
  let packer: image.ImagePacker | null = null;
  try {
    packer = image.createImagePacker();
    const options: image.PackingOption = { format: 'image/png', quality: 100 };
    const packed: ArrayBuffer = await packer.packToData(pixelMap, options);
    return `data:image/png;base64,${base64Encode(new Uint8Array(packed))}`;
  } catch (error) {
    AALog.warn(`Encoding the avatar failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  } finally {
    if (packer !== null) {
      try {
        await packer.release();
      } catch (error) {
        AALog.debug('Releasing the image packer failed');
      }
    }
    try {
      await pixelMap.release();
    } catch (error) {
      AALog.debug('Releasing the avatar bitmap failed');
    }
  }
}
