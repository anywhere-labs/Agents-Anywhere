/**
 * Terminal shortcut deck keys.
 *
 * Port of the `TerminalShortcut` enum and the slice of Termux's `KeyHandler`
 * that the deck can reach (`feature/terminal/RemoteTerminalController.kt`'s
 * `sendKeyShortcut`).
 *
 * Termux's `KeyHandler` is not vendored in the Android project — it arrives in
 * the `termux-terminal-view` artifact — so the escape sequences below are
 * transcribed from `com.termux.terminal.KeyHandler#getCode` at the version the
 * Android client pins (`v0.118.3`). Only the keys the deck sends are ported.
 *
 * Two of that method's quirks are load bearing and are reproduced here:
 *  - an unmodified cursor key switches between `ESC O x` and `ESC [ x` with the
 *    terminal's application-cursor mode, while a modified one always uses the
 *    `ESC [ 1 ; n x` form;
 *  - `PAGE_UP`/`PAGE_DOWN` ignore modifiers entirely and always answer `ESC [ 5 ~`
 *    and `ESC [ 6 ~`.
 *
 * The Kotlin code passes Android `KEYMOD_*` bit flags into `getCode`. Since the
 * deck can only latch control and alt, this port passes the *modifier number*
 * those flags collapse to (the value that ends up inside the escape sequence)
 * instead of rebuilding 32-bit flag arithmetic in JavaScript.
 */

export enum TerminalShortcut {
  Esc = 0,
  Slash = 1,
  Dash = 2,
  Home = 3,
  Up = 4,
  End = 5,
  PageUp = 6,
  Tab = 7,
  Ctrl = 8,
  Alt = 9,
  Left = 10,
  Down = 11,
  Right = 12,
  PageDown = 13,
}

/** The label drawn on each key, matching `TerminalShortcut.label`. */
export function terminalShortcutLabel(shortcut: TerminalShortcut): string {
  switch (shortcut) {
    case TerminalShortcut.Esc: return 'ESC';
    case TerminalShortcut.Slash: return '/';
    case TerminalShortcut.Dash: return '-';
    case TerminalShortcut.Home: return 'HOME';
    case TerminalShortcut.Up: return '\u2191';
    case TerminalShortcut.End: return 'END';
    case TerminalShortcut.PageUp: return 'PGUP';
    case TerminalShortcut.Tab: return 'TAB';
    case TerminalShortcut.Ctrl: return 'CTRL';
    case TerminalShortcut.Alt: return 'ALT';
    case TerminalShortcut.Left: return '\u2190';
    case TerminalShortcut.Down: return '\u2193';
    case TerminalShortcut.Right: return '\u2192';
    case TerminalShortcut.PageDown: return 'PGDN';
    default: return '';
  }
}

/** Android `KeyEvent` codes for the keys the deck sends. */
export class AAKeyCode {
  static readonly DPAD_UP: number = 19;
  static readonly DPAD_DOWN: number = 20;
  static readonly DPAD_LEFT: number = 21;
  static readonly DPAD_RIGHT: number = 22;
  static readonly PAGE_UP: number = 92;
  static readonly PAGE_DOWN: number = 93;
  static readonly MOVE_HOME: number = 122;
  static readonly MOVE_END: number = 123;
}

/**
 * `KeyHandler.transformForModifiers`, where the modifier argument is already the
 * number that belongs in the sequence (0 meaning "unmodified").
 */
function transformForModifiers(start: string, modifier: number, lastChar: string): string {
  if (modifier === 0) {
    return start + lastChar;
  }
  return `${start};${modifier}${lastChar}`;
}

/**
 * `KeyHandler.getCode`, restricted to the deck's keys.
 *
 * Returns `null` when the key is not one this port sends, which is the Kotlin
 * method's own "no sequence" answer.
 */
export function keyHandlerCode(
  keyCode: number,
  modifier: number,
  cursorAppMode: boolean,
): string | null {
  switch (keyCode) {
    case AAKeyCode.DPAD_UP:
      return modifier === 0
        ? (cursorAppMode ? '\u001bOA' : '\u001b[A')
        : transformForModifiers('\u001b[1', modifier, 'A');
    case AAKeyCode.DPAD_DOWN:
      return modifier === 0
        ? (cursorAppMode ? '\u001bOB' : '\u001b[B')
        : transformForModifiers('\u001b[1', modifier, 'B');
    case AAKeyCode.DPAD_RIGHT:
      return modifier === 0
        ? (cursorAppMode ? '\u001bOC' : '\u001b[C')
        : transformForModifiers('\u001b[1', modifier, 'C');
    case AAKeyCode.DPAD_LEFT:
      return modifier === 0
        ? (cursorAppMode ? '\u001bOD' : '\u001b[D')
        : transformForModifiers('\u001b[1', modifier, 'D');
    case AAKeyCode.MOVE_HOME:
      return modifier === 0
        ? (cursorAppMode ? '\u001bOH' : '\u001b[H')
        : transformForModifiers('\u001b[1', modifier, 'H');
    case AAKeyCode.MOVE_END:
      return modifier === 0
        ? (cursorAppMode ? '\u001bOF' : '\u001b[F')
        : transformForModifiers('\u001b[1', modifier, 'F');
    case AAKeyCode.PAGE_UP:
      return '\u001b[5~';
    case AAKeyCode.PAGE_DOWN:
      return '\u001b[6~';
    default:
      return null;
  }
}

/** The Android key code a shortcut maps to, or `-1` for the non-key shortcuts. */
export function shortcutKeyCode(shortcut: TerminalShortcut): number {
  switch (shortcut) {
    case TerminalShortcut.Home: return AAKeyCode.MOVE_HOME;
    case TerminalShortcut.Up: return AAKeyCode.DPAD_UP;
    case TerminalShortcut.End: return AAKeyCode.MOVE_END;
    case TerminalShortcut.PageUp: return AAKeyCode.PAGE_UP;
    case TerminalShortcut.Left: return AAKeyCode.DPAD_LEFT;
    case TerminalShortcut.Down: return AAKeyCode.DPAD_DOWN;
    case TerminalShortcut.Right: return AAKeyCode.DPAD_RIGHT;
    case TerminalShortcut.PageDown: return AAKeyCode.PAGE_DOWN;
    default: return -1;
  }
}

/** The modifier number an escape sequence carries for the given latches. */
export function keyModifierNumber(ctrl: boolean, alt: boolean): number {
  if (ctrl && alt) {
    return 7;
  }
  if (ctrl) {
    return 5;
  }
  if (alt) {
    return 3;
  }
  return 0;
}
