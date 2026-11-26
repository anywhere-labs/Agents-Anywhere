// Extra-keys row (Esc, Ctrl, Tab, arrows, PgUp/PgDn, Home/End) → bytes the shell expects.
//
// Framework-free so the same mapping serves the Web on-screen row and, later, the native glass key bar on mobile
// (doc §5: native sends the key over the bridge, the terminal component turns it into a sequence).

export type ExtraKey =
  | "escape"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"

export interface KeyModifiers {
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

export interface KeyContext {
  /** DECCKM (`CSI ? 1 h`, xterm.js `modes.applicationCursorKeysMode`): arrows / Home / End use SS3 form. */
  applicationCursorKeys?: boolean
}

/** Keys shown in the on-screen row, in order. `ctrl` is the sticky modifier toggle, not a sequence. */
export const EXTRA_KEY_ROW: readonly (ExtraKey | "ctrl")[] = [
  "escape",
  "ctrl",
  "tab",
  "left",
  "up",
  "down",
  "right",
  "home",
  "end",
  "pageUp",
  "pageDown",
]

const CURSOR_FINAL: Partial<Record<ExtraKey, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
}

const TILDE_CODE: Partial<Record<ExtraKey, number>> = {
  pageUp: 5,
  pageDown: 6,
}

/** xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). 1 = no modifier. */
function modifierParam(mods: KeyModifiers): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

export function keySequence(key: ExtraKey, mods: KeyModifiers = {}, ctx: KeyContext = {}): string {
  const param = modifierParam(mods)
  switch (key) {
    case "escape":
      return mods.alt ? "\x1b\x1b" : "\x1b"
    case "tab":
      if (mods.shift) return "\x1b[Z"
      return mods.alt ? "\x1b\t" : "\t"
    default:
      break
  }
  const final = CURSOR_FINAL[key]
  if (final) {
    if (param > 1) return `\x1b[1;${param}${final}`
    return ctx.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`
  }
  const code = TILDE_CODE[key]
  if (code != null) return param > 1 ? `\x1b[${code};${param}~` : `\x1b[${code}~`
  return ""
}

/**
 * Apply a latched Ctrl to typed text (soft keyboards cannot hold Ctrl). Only a single character is transformed;
 * anything else (a paste, an IME commit) passes through unchanged.
 */
export function applyCtrl(data: string): string {
  if (data.length !== 1) return data
  const ch = data
  const code = ch.charCodeAt(0)
  if (ch >= "a" && ch <= "z") return String.fromCharCode(code - 96)
  if (ch >= "@" && ch <= "_") return String.fromCharCode(code - 64) // A-Z, @ [ \ ] ^ _
  if (ch === " " || ch === "2") return "\x00"
  if (ch === "?" || ch === "8") return "\x7f"
  if (ch === "3") return "\x1b"
  if (ch === "4") return "\x1c"
  if (ch === "5") return "\x1d"
  if (ch === "6") return "\x1e"
  if (ch === "7" || ch === "/" || ch === "-") return "\x1f"
  return data
}
