/**
 * Icon path data.
 *
 * Each constant is the outline of a Lucide icon in its native 24x24 box, so an
 * `AAIcon(commands: AA_ICONS.x)` renders the same shape the Android client draws.
 * Geometry is transcribed from the Lucide sources rather than approximated;
 * rounded rectangles are expanded into explicit `A` arcs because ArkUI's `Path`
 * only consumes path commands.
 *
 * Add icons here as screens need them, and keep the Lucide name as the key so a
 * future reader can diff against the Android imports.
 */
export class AA_ICONS {
  /** lucide `qr-code` — the "Scan to Login" entry point. */
  static readonly QR_CODE: string =
    'M4 3h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'
    + 'M17 3h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'
    + 'M4 16h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z'
    + 'M21 16h-3a2 2 0 0 0-2 2v3'
    + 'M21 21v.01'
    + 'M12 7v3a2 2 0 0 1-2 2H7'
    + 'M3 12h.01'
    + 'M12 3h.01'
    + 'M12 16v.01'
    + 'M16 12h1'
    + 'M21 12v.01'
    + 'M12 21v-1';

  /** lucide `key-round` — the "Account Password Login" entry point. */
  static readonly KEY_ROUND: string =
    'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1'
    + 'a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4Z'
    + 'M16.5 7.5m-0.5 0a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0-1 0';

  /**
   * lucide `user-key` — the password sign-in button.
   *
   * Android ships this as a vector drawable (`ic_user_key.xml`) whose path data
   * is copied here verbatim, so the geometry is identical rather than merely
   * similar to a neighbouring Lucide glyph.
   */
  static readonly USER_KEY: string =
    'M20 11v6M20 13h2M3 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 2.072.578'
    + 'M14 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0M22 19a2 2 0 1 1-4 0a2 2 0 1 1 4 0';

  static readonly CHEVRON_LEFT: string = 'm15 18-6-6 6-6';
  static readonly CHEVRON_RIGHT: string = 'm9 18 6-6-6-6';
  static readonly CHEVRON_DOWN: string = 'm6 9 6 6 6-6';
  static readonly CHEVRON_UP: string = 'm18 15-6-6-6 6';
  /** lucide `chevrons-up-down` — the popup affordance on the settings rows. */
  static readonly CHEVRONS_UP_DOWN: string = 'm7 15 5 5 5-5 m7 9 5-5 5 5';
  static readonly CHECK: string = 'M20 6 9 17l-5-5';
  static readonly X: string = 'M18 6 6 18M6 6l12 12';
  static readonly PLUS: string = 'M5 12h14M12 5v14';
  static readonly MINUS: string = 'M5 12h14';
  static readonly ELLIPSIS: string = 'M5 12h.01M12 12h.01M19 12h.01';

  static readonly SEARCH: string =
    'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z m10 18-4.34-4.34';

  static readonly ARROW_LEFT: string = 'm12 19-7-7 7-7M19 12H5';
  static readonly ARROW_UP: string = 'M12 19V5m-7 7 7-7 7 7';
  static readonly ARROW_DOWN: string = 'M12 5v14m7-7-7 7-7-7';

  static readonly CIRCLE: string = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z';

  static readonly CIRCLE_CHECK: string =
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3 10 2 2 4-4';

  static readonly CIRCLE_ALERT: string =
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 8v4M12 16h.01';

  static readonly INFO: string = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 16v-4M12 8h.01';

  static readonly CLOCK: string = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6v6l4 2';

  static readonly MONITOR: string =
    'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 21h8M12 17v4';

  static readonly FOLDER: string =
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4'
    + 'a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';

  static readonly FOLDER_OPEN: string =
    'M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4'
    + 'a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2';

  static readonly LIST: string =
    'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01';

  /**
   * lucide `panel-left` — the shell's sidebar toggle.
   *
   * The iOS client's toolbar item is `SidebarMenuIcon()` (`sidebar.left`) and
   * always calls `toggleSidebar` (`Views/Chat/ChatPageToolbar.swift`); this is the
   * same frame with a dividing line, which is what the Lucide set draws.
   */
  static readonly PANEL_LEFT: string = 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM9 3v18';

  static readonly TERMINAL: string = 'm4 17 6-6-6-6M12 19h8';

  /** lucide `cloud` — the Cloud sign-in entry, which iOS draws with SF `cloud`. */
  static readonly CLOUD: string = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z';

  static readonly USER_ROUND: string = 'M12 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM20 21a8 8 0 0 0-16 0';

  static readonly SERVER: string =
    'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z'
    + 'M3 15a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z'
    + 'M7 7h.01M7 17h.01';

  /** lucide `mail` — the email row of the settings list. */
  static readonly ENVELOPE: string =
    'M22 7 13.03 12.7a2 2 0 0 1-2.06 0L2 7'
    + 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z';

  static readonly GLOBE: string =
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM2 12h20'
    + 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z';

  static readonly MOON: string = 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z';

  static readonly SUN: string =
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'
    + 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41'
    + 'M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41';

  static readonly ARCHIVE: string =
    'M3 4h18v4H3ZM20 8v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8ZM10 12h4';

  static readonly ARCHIVE_RESTORE: string =
    'M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'
    + 'M4 8v11a2 2 0 0 0 2 2h2'
    + 'M20 8v11a2 2 0 0 1-2 2h-2'
    + 'M9 15l3-3 3 3'
    + 'M12 12v9';

  static readonly LOG_OUT: string =
    'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5M21 12H9';

  static readonly DOWNLOAD: string =
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5M12 15V3';

  static readonly TRASH: string =
    'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
    + 'M10 11v6M14 11v6';

  static readonly REFRESH: string =
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5'
    + 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5';

  static readonly PENCIL: string =
    'M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62'
    + 'l4.35-1.32a2 2 0 0 0 .83-.5ZM15 5l4 4';

  static readonly PIN: string =
    'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12'
    + 'a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1'
    + '2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z';

  static readonly SQUARE_PEN: string =
    'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'
    + 'M18.37 2.63a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z';

  /** lucide `hammer` — the fallback icon for a generic tool activity row. */
  static readonly HAMMER: string =
    'm15 12-8.373 8.373a1 1 0 1 1-3-3L12 9'
    + 'm18 15 4-4'
    + 'm21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96'
    + 'l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5';

  /**
   * lucide `sliders-horizontal` — the session header's model settings entry.
   *
   * Android draws this slot from a PNG (`ic_session_runtime_settings_*`); the
   * vector is used here so the button scales with the palette instead of needing
   * two raster assets. Swapping in the original art is part of the asset pass.
   */
  static readonly SLIDERS_HORIZONTAL: string =
    'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4';

  /**
   * lucide `copy` — the code panel's copy affordance.
   *
   * Android draws the resting state from a bitmap and the confirmation from a
   * hand-drawn check glyph; both are vectors here so the colour follows the
   * palette. The originals come back with the asset pass.
   */
  static readonly COPY: string =
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'
    + 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z';

  /**
   * Attachment source icons.
   *
   * Android draws these from six bitmaps (`ic_attachment_{camera,photo,file}_*`),
   * which the asset pass restores; the vectors keep the same 22dp footprint.
   */
  static readonly CAMERA: string =
    'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z'
    + 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z';

  static readonly IMAGE: string =
    'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'
    + 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'
    + 'M21 15l-5-5L5 21';

  static readonly FILE: string =
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'
    + 'M14 2v5h5';

  /**
   * lucide `laptop` — the macOS device glyph on the devices page.
   *
   * Android uses twelve device bitmaps (`device_icon_{light,dark}_{macos,
   * windows,linux}_{online,offline}_3x`); these vectors stand in until the asset
   * pass restores them.
   */
  static readonly LAPTOP: string =
    'M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9'
    + 'M4 16h16l1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45Z';

  /** lucide `hash` — the pair-code option in the pairing wizard. */
  static readonly HASH: string = 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18';

  /** lucide `external-link` — "open the download page" in the pairing wizard. */
  static readonly EXTERNAL_LINK: string =
    'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6';

  /** lucide `square-arrow-out-up-right` — the share button under a reply. */
  static readonly SQUARE_ARROW_OUT_UP_RIGHT: string =
    'M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6m10 0-9 9m3-9h6v6';

  /** lucide `braces` — a JSON file in the browser. */
  static readonly BRACES: string =
    'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1'
    + 'M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1';

  /** lucide `file-text` — a text or markdown file in the browser. */
  static readonly FILE_TEXT: string =
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'
    + 'M14 2v5h5M16 13H8M16 17H8M10 9H8';

  /** lucide `file-code` — a source file in the browser. */
  static readonly FILE_CODE: string =
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'
    + 'M14 2v5h5M10 13l-2 2 2 2M14 17l2-2-2-2';

  /**
   * lucide `eye` / `eye-off` — the reveal button on a secure runtime field.
   *
   * iOS draws the same pair (`eye` / `eye.slash`) inside `RuntimeSecretInput`;
   * Android has no equivalent because its configuration sheet has no secret
   * field, so these are the first glyphs here taken from iOS rather than Android.
   */
  static readonly EYE: string =
    'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'
    + 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z';

  static readonly EYE_OFF: string =
    'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'
    + 'M14.084 14.158a3 3 0 0 1-4.242-4.242'
    + 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'
    + 'm2 2 20 20';
}

/**
 * Hand-drawn line glyphs from Android's `ui/designsystem/Glyphs.kt`.
 *
 * Android draws these on a Canvas whose coordinates are fractions of the icon
 * size, so the paths below are those fractions scaled into the 24x24 box
 * `AAIcon` uses. A stroke on a 22dp canvas has to be scaled too: Android's
 * 3.5dp on 22dp is `3.5 * 24 / 22`, which is why each constant carries the
 * stroke width it must be drawn with.
 */
export class AA_GLYPHS {
  /** `BackGlyph`: a left chevron, 22dp with a 3.5dp stroke. */
  static readonly BACK: string = 'M15.84 5.28 8.16 12l7.68 6.72';
  static readonly BACK_STROKE: number = 3.82;

  /** `ForwardGlyph`: a right chevron, 22dp with a 3.2dp stroke. */
  static readonly FORWARD: string = 'M9.12 5.28 15.84 12l-6.72 6.72';
  static readonly FORWARD_STROKE: number = 3.49;

  /** `DownGlyph`: a wide chevron, 18dp with a 3dp stroke. */
  static readonly DOWN: string = 'M6 9.12 12 15.36l6-6.24';
  static readonly DOWN_STROKE: number = 4;
}
