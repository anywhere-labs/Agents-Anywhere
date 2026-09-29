import { AA_LIGHT_COLORS, AAColors } from './AAColors';

/**
 * The "Agents Anywhere" wordmark.
 *
 * Android renders it in the bundled `caveat_wght.ttf` at Medium weight, 42sp on
 * the sign-in screen and 31sp in the Home header. The same font file is bundled
 * here and registered as `AACaveat` by `EntryAbility`.
 */
@Component
export struct AAWordmark {
  colors: AAColors = AA_LIGHT_COLORS;
  fontSize: number = 42;
  /** Android uses 44sp line height at 42sp and 40sp at 31sp. */
  lineHeight: number = 44;

  build() {
    Text('Agents Anywhere')
      .fontFamily('AACaveat')
      .fontSize(this.fontSize)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.colors.ink)
      .lineHeight(this.lineHeight)
      .maxLines(1)
  }
}
