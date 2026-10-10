/**
 * Layout and typography tokens shared by every screen.
 *
 * The Android client uses raw dp/sp values inline; the values recorded here are
 * the ones that repeat across screens, so a screen should prefer a token when
 * one exists and fall back to a literal when it does not. Keeping the repeated
 * values named is what makes a screen-for-screen port reviewable.
 */

/** Horizontal page padding. Android uses 32 on auth, 18 on home, 24 on device lists, 22 in dialogs. */
export class AASpacing {
  static readonly AUTH_SCREEN_H: number = 32;
  static readonly HOME_H: number = 18;
  static readonly DEVICE_LIST_H: number = 24;
  static readonly DIALOG_H: number = 22;
  static readonly CARD_PADDING: number = 22;
  static readonly HOME_TOP: number = 6;
  static readonly AUTH_TOP: number = 104;
  static readonly AUTH_WEB_TOP: number = 74;
  static readonly AUTH_BOTTOM: number = 30;
}

/** Corner radii, matching the Android shapes in use. */
export class AARadius {
  static readonly SMALL: number = 8;
  static readonly BUTTON: number = 12;
  static readonly CHIP: number = 14;
  static readonly CARD: number = 18;
  static readonly SHEET: number = 28;
  static readonly DIALOG: number = 26;
  static readonly AUTH_INPUT: number = 17;
  static readonly BUBBLE: number = 22;
  static readonly PILL: number = 999;
}

/** Font sizes in fp. */
export class AAFontSize {
  static readonly WORDMARK: number = 42;
  static readonly TITLE_LARGE: number = 28;
  static readonly TITLE: number = 20;
  static readonly HEADER: number = 17;
  static readonly BUTTON: number = 15.3;
  static readonly BODY: number = 15;
  static readonly LABEL: number = 14;
  static readonly CAPTION: number = 13;
  static readonly SMALL: number = 12;
  static readonly TINY: number = 11;
}

/** Standard control heights. */
export class AAHeight {
  static readonly AUTH_BUTTON: number = 56;
  static readonly AUTH_INPUT: number = 62;
  static readonly HEADER: number = 64;
  static readonly QUICK_ENTRY: number = 76;
  static readonly LIST_ROW: number = 52;
  static readonly DIALOG_BUTTON: number = 50;
  static readonly CIRCLE_BUTTON: number = 42;
}

/** Shared shadows. Android expresses these as elevation in dp. */
export class AAElevation {
  static readonly CARD: number = 14;
  static readonly DIALOG: number = 34;
  static readonly FLOATING: number = 20;
}
