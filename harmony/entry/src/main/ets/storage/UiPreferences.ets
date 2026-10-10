import { AAPreferenceNames, AAPreferenceStore } from './AAPreferences';
import { AAAppearanceMode, AALanguageMode } from '../ui/designsystem/AAColors';

/**
 * UI preferences: appearance, language and sidebar view mode.
 *
 * Ported from the `agents_anywhere_ui` SharedPreferences usage in
 * `MainActivity.kt` and `HomeSidebarViewMode.kt`.
 *
 * These are never cleared on sign-out, matching Android: a user who changes the
 * theme keeps it after signing out and back in.
 */
export class UiPreferences {
  private readonly store: AAPreferenceStore;

  constructor() {
    this.store = new AAPreferenceStore(AAPreferenceNames.UI);
  }

  private static readonly KEY_APPEARANCE: string = 'appearance_mode';
  private static readonly KEY_LANGUAGE: string = 'language_mode';
  private static readonly KEY_SIDEBAR_VIEW: string = 'sidebar_view_mode';

  appearanceMode(): string {
    const value: string = this.store.getString(
      UiPreferences.KEY_APPEARANCE,
      AAAppearanceMode.SYSTEM,
    );
    return UiPreferences.normalizeAppearance(value);
  }

  setAppearanceMode(mode: string): void {
    this.store.setString(UiPreferences.KEY_APPEARANCE, UiPreferences.normalizeAppearance(mode));
  }

  languageMode(): string {
    const value: string = this.store.getString(UiPreferences.KEY_LANGUAGE, AALanguageMode.SYSTEM);
    return UiPreferences.normalizeLanguage(value);
  }

  setLanguageMode(mode: string): void {
    this.store.setString(UiPreferences.KEY_LANGUAGE, UiPreferences.normalizeLanguage(mode));
  }

  sidebarViewMode(): string {
    return normalizeSidebarViewMode(
      this.store.getString(UiPreferences.KEY_SIDEBAR_VIEW, SIDEBAR_VIEW_PROJECT),
    );
  }

  setSidebarViewMode(mode: string): void {
    this.store.setString(UiPreferences.KEY_SIDEBAR_VIEW, normalizeSidebarViewMode(mode));
  }

  private static normalizeAppearance(value: string): string {
    if (value === AAAppearanceMode.LIGHT || value === AAAppearanceMode.DARK) {
      return value;
    }
    return AAAppearanceMode.SYSTEM;
  }

  private static normalizeLanguage(value: string): string {
    if (value === AALanguageMode.ENGLISH || value === AALanguageMode.SIMPLIFIED_CHINESE) {
      return value;
    }
    return AALanguageMode.SYSTEM;
  }
}

/** Sidebar view mode values, matching `HomeSidebarViewMode`. */
export const SIDEBAR_VIEW_PROJECT: string = 'project';
export const SIDEBAR_VIEW_SESSION: string = 'session';

/** Android normalizes anything that is not exactly `"session"` to project view. */
export function normalizeSidebarViewMode(value: string): string {
  return value === SIDEBAR_VIEW_SESSION ? SIDEBAR_VIEW_SESSION : SIDEBAR_VIEW_PROJECT;
}
