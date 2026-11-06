import { AAColors } from './AAColors';
import { CodeTokenKind } from '../../feature/sessiondetail/CodeTokenizer';

/**
 * Code colours.
 *
 * The values are the ones the two TextMate themes the Android client ships —
 * `assets/textmate/quietlight.json` (light) and `darcula.json` (dark) — assign to
 * the scopes the scanner's token kinds stand for:
 *
 * | Token kind   | TextMate scope                                   | quietlight | darcula |
 * | ---          | ---                                              | ---        | ---     |
 * | Comment      | `comment`                                        | `#AAAAAA` italic | `#707070` |
 * | Keyword      | `keyword` / `storage`                            | `#4B69C6`  | `#CC8242` |
 * | Type         | `entity.name.type` / `support.type`              | `#7A3E9D` bold | `#7A9EC2` |
 * | Selector     | `meta.selector.css`                              | `#7A3E9D`  | `#FFC66D` |
 * | Function     | `entity.name.function` / `support.function`      | `#AA3731` bold | `#FFC66D` |
 * | Number       | `constant.numeric`                               | `#9C5D27`  | `#7A9EC2` |
 * | String       | `string`                                         | `#448C27`  | `#6A8759` |
 * | Constant     | `constant.language`                              | `#9C5D27`  | `#CC8242` |
 * | Variable     | `variable`                                       | `#7A3E9D`  | `#9E7BB0` |
 * | Operator     | `keyword.operator`                               | `#777777`  | `#CCCCCC` |
 * | Punctuation  | `punctuation`                                    | `#777777`  | `#CCCCCC` |
 * | Tag          | `entity.name.tag`                                | `#4B69C6`  | `#FFC66D` |
 * | Attribute    | `entity.other.attribute-name`                    | `#8190A0` italic | `#CCCCCC` |
 * | PropertyKey  | `meta.property-name` / object keys               | `#9C5D27`  | `#9E7BB0` |
 *
 * Two scopes are resolved rather than copied: markup tag *punctuation* is
 * `#91B3E0` in quietlight but the tag name itself is `#4B69C6`, and the darker of
 * the two is used for both; and the plain foreground is the theme's default
 * (`#333333` / `#CCCCCC`). The panel chrome below the table comes from
 * `MarkdownCodePanelContent` and `configureReadOnlyCodeEditor` instead of a
 * theme, and is copied value for value.
 */

export interface CodeTokenStyle {
  color: string;
  bold: boolean;
  italic: boolean;
}

export interface CodePalette {
  isDark: boolean;
  /** Panel surface: raised surface in dark mode, `#ECECEA` in light. */
  panel: string;
  /** Panel label (`Bash`, `python`, …). */
  label: string;
  /** Panel border, dark mode only. */
  border: string;
  /** Panel shadow; the panel uses its own, not `appShadow`. */
  shadow: string;
  /** Gutter numbers. */
  lineNumber: string;
  /** In-file search: every match. */
  searchMatch: string;
  /** In-file search: the match the jump is currently on. */
  searchMatchCurrent: string;
  /** Bash prompt token, i.e. the first word of a command. */
  prompt: string;
  /** Bash command text after the prompt. */
  command: string;
  styles: Map<CodeTokenKind, CodeTokenStyle>;
}

function style(color: string, bold: boolean, italic: boolean): CodeTokenStyle {
  return { color: color, bold: bold, italic: italic };
}

function buildStyles(dark: boolean): Map<CodeTokenKind, CodeTokenStyle> {
  const styles: Map<CodeTokenKind, CodeTokenStyle> = new Map();
  if (dark) {
    styles.set(CodeTokenKind.Plain, style('#CCCCCC', false, false));
    styles.set(CodeTokenKind.Comment, style('#707070', false, false));
    styles.set(CodeTokenKind.Keyword, style('#CC8242', false, false));
    styles.set(CodeTokenKind.Type, style('#7A9EC2', false, false));
    styles.set(CodeTokenKind.Selector, style('#FFC66D', false, false));
    styles.set(CodeTokenKind.Function, style('#FFC66D', false, false));
    styles.set(CodeTokenKind.Number, style('#7A9EC2', false, false));
    styles.set(CodeTokenKind.String, style('#6A8759', false, false));
    styles.set(CodeTokenKind.Constant, style('#CC8242', false, false));
    styles.set(CodeTokenKind.Variable, style('#9E7BB0', false, false));
    styles.set(CodeTokenKind.Operator, style('#CCCCCC', false, false));
    styles.set(CodeTokenKind.Punctuation, style('#CCCCCC', false, false));
    styles.set(CodeTokenKind.Tag, style('#FFC66D', false, false));
    styles.set(CodeTokenKind.Attribute, style('#CCCCCC', false, false));
    styles.set(CodeTokenKind.PropertyKey, style('#9E7BB0', false, false));
    return styles;
  }
  styles.set(CodeTokenKind.Plain, style('#333333', false, false));
  styles.set(CodeTokenKind.Comment, style('#AAAAAA', false, true));
  styles.set(CodeTokenKind.Keyword, style('#4B69C6', false, false));
  styles.set(CodeTokenKind.Type, style('#7A3E9D', true, false));
  styles.set(CodeTokenKind.Selector, style('#7A3E9D', false, false));
  styles.set(CodeTokenKind.Function, style('#AA3731', true, false));
  styles.set(CodeTokenKind.Number, style('#9C5D27', false, false));
  styles.set(CodeTokenKind.String, style('#448C27', false, false));
  styles.set(CodeTokenKind.Constant, style('#9C5D27', false, false));
  styles.set(CodeTokenKind.Variable, style('#7A3E9D', false, false));
  styles.set(CodeTokenKind.Operator, style('#777777', false, false));
  styles.set(CodeTokenKind.Punctuation, style('#777777', false, false));
  styles.set(CodeTokenKind.Tag, style('#4B69C6', false, false));
  styles.set(CodeTokenKind.Attribute, style('#8190A0', false, true));
  styles.set(CodeTokenKind.PropertyKey, style('#9C5D27', false, false));
  return styles;
}

const LIGHT_STYLES: Map<CodeTokenKind, CodeTokenStyle> = buildStyles(false);
const DARK_STYLES: Map<CodeTokenKind, CodeTokenStyle> = buildStyles(true);

function buildPalette(isDark: boolean, panel: string, label: string, shadow: string): CodePalette {
  return {
    isDark: isDark,
    panel: panel,
    label: label,
    border: isDark ? '#27272A' : '#00000000',
    shadow: shadow,
    lineNumber: isDark ? '#A1A1AA' : '#8D8B84',
    // Search highlights are this app's own warm tones: Android's are Sora's
    // built-in magenta, which the Android client never overrides, but the port's
    // renderer is self-authored and keeps to the app palette (see the plan).
    searchMatch: isDark ? '#4A3A12' : '#FFE9A8',
    searchMatchCurrent: isDark ? '#8A6A1A' : '#FFC94D',
    prompt: isDark ? '#E8798F' : '#C45D74',
    command: isDark ? '#FAFAFA' : '#181916',
    styles: isDark ? DARK_STYLES : LIGHT_STYLES,
  };
}

export const AA_LIGHT_CODE_PALETTE: CodePalette =
  buildPalette(false, '#ECECEA', '#191A18', '#0A000000');
export const AA_DARK_CODE_PALETTE: CodePalette =
  buildPalette(true, '#1F1F1F', '#FAFAFA', '#66000000');

export function codePalette(colors: AAColors): CodePalette {
  if (!colors.isDark) {
    return AA_LIGHT_CODE_PALETTE;
  }
  // The dark panel sits on the raised surface, which is a design token; the
  // rest of the dark chrome is fixed by Android's own literals.
  return buildPalette(true, colors.raisedSurface, '#FAFAFA', '#66000000');
}

export function tokenStyle(palette: CodePalette, kind: CodeTokenKind): CodeTokenStyle {
  const found: CodeTokenStyle | undefined = palette.styles.get(kind);
  return found === undefined ? palette.styles.get(CodeTokenKind.Plain)
    ?? { color: '#333333', bold: false, italic: false } : found;
}
