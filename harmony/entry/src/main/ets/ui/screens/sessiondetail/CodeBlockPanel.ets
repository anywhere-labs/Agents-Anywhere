import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { CodePalette, codePalette } from '../../designsystem/AACodeColors';
import { CodeLinesView } from '../../designsystem/AACodeLines';
import { copyTextToClipboard } from '../../../common/AAClipboard';
import { bashCommandLines, normalizeCodeText } from '../../../feature/sessiondetail/CodeTokenizer';

/**
 * Code panels.
 *
 * Port of `MarkdownCodePanelContent` and `BashCommandCard` in
 * `ui/screens/sessiondetail/AgentMarkdownText.kt`, plus the editor chrome from
 * `configureReadOnlyCodeEditor` in `CodeBlockPreview.kt`.
 *
 * Chrome, copied value for value from Android:
 *
 *  - panel: 20dp radius, `#ECECEA` in light and the raised surface in dark, 1dp
 *    `#27272A` border in dark mode only, 20dp shadow (`#0A000000` light,
 *    `#66000000` dark), minimum height 112dp, padding 18/17/18/12 (18 bottom for
 *    the bash card), label 14sp/18sp bold;
 *  - code: 12sp monospace, 15dp line height, 8dp top padding, a line-number gutter
 *    right-aligned 8dp from each edge with no divider (`setDividerWidth(0f)`), and
 *    horizontal scrolling only, so the gutter stays put;
 *  - height: the panel body is `lines * 15 + 12`, which is what Android passes to
 *    `SoraCodeBlock` as `fixedHeight`.
 *
 * The highlighted lines themselves are drawn by `CodeLinesView`, which the file
 * preview also uses, so a code fence and a file render identically.
 */

const LABEL_SIZE: number = 14;
const LABEL_LINE_HEIGHT: number = 18;
const CODE_LINE_HEIGHT: number = 15;
const CODE_TOP_PADDING: number = 8;
const COPY_FEEDBACK_MILLIS: number = 1100;

/** Panel with a label, a copy button and the highlighted code. */
@Component
export struct CodeBlockPanel {
  colors: AAColors = AA_LIGHT_COLORS;
  label: string = 'code';
  code: string = '';
  @State private copied: boolean = false;
  private copyTimer: number = -1;

  aboutToDisappear(): void {
    if (this.copyTimer >= 0) {
      clearTimeout(this.copyTimer);
      this.copyTimer = -1;
    }
  }

  private palette(): CodePalette {
    return codePalette(this.colors);
  }

  /** Android's `markdownCodePanelHeight` body: one 15dp row per line plus 12dp. */
  private codeHeight(): number {
    const lines: string[] = normalizeCodeText(this.code).split('\n');
    const count: number = lines.length < 1 ? 1 : lines.length;
    return count * CODE_LINE_HEIGHT + 12;
  }

  private copy(): void {
    if (this.code.trim().length === 0) {
      return;
    }
    void copyTextToClipboard(this.code).then((done: boolean) => {
      if (!done) {
        return;
      }
      this.copied = true;
      if (this.copyTimer >= 0) {
        clearTimeout(this.copyTimer);
      }
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        this.copyTimer = -1;
      }, COPY_FEEDBACK_MILLIS);
    });
  }

  build() {
    Column() {
      Row() {
        Text(this.label.length > 0 ? this.label : 'code')
          .fontSize(LABEL_SIZE)
          .lineHeight(LABEL_LINE_HEIGHT)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.palette().label)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        CopyIconButton({
          colors: this.colors,
          copied: this.copied,
          description: 'Copy code',
          onTap: () => this.copy(),
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      Column().height(14)

      CodeLinesView({
        colors: this.colors,
        label: this.label,
        code: this.code,
        fixedHeight: this.codeHeight(),
        showGutter: true,
        topPadding: CODE_TOP_PADDING,
      })
    }
    .width('100%')
    .constraintSize({ minHeight: 112 })
    .borderRadius(20)
    .backgroundColor(this.palette().panel)
    .border({
      width: this.colors.isDark ? 1 : 0,
      color: this.palette().border,
    })
    .shadow({ radius: 20, color: this.palette().shadow, offsetX: 0, offsetY: 0 })
    .padding({ left: 18, top: 17, right: 18, bottom: 12 })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * One command card.
 *
 * Android turns a bash fence into one card per non-blank line, each with the
 * `Bash` label, a 31dp gap, and the command split into a prompt-coloured first
 * word and the rest.
 */
@Component
export struct BashCommandCard {
  colors: AAColors = AA_LIGHT_COLORS;
  label: string = 'Bash';
  /** The command, already trimmed to a single line by the caller. */
  command: string = '';
  @State private copied: boolean = false;
  private copyTimer: number = -1;

  aboutToDisappear(): void {
    if (this.copyTimer >= 0) {
      clearTimeout(this.copyTimer);
      this.copyTimer = -1;
    }
  }

  private palette(): CodePalette {
    return codePalette(this.colors);
  }

  private copy(): void {
    if (this.command.trim().length === 0) {
      return;
    }
    void copyTextToClipboard(this.command).then((done: boolean) => {
      if (!done) {
        return;
      }
      this.copied = true;
      if (this.copyTimer >= 0) {
        clearTimeout(this.copyTimer);
      }
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        this.copyTimer = -1;
      }, COPY_FEEDBACK_MILLIS);
    });
  }

  build() {
    Column() {
      Row() {
        Text(this.label)
          .fontSize(LABEL_SIZE)
          .lineHeight(LABEL_LINE_HEIGHT)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.palette().label)
          .maxLines(1)
          .layoutWeight(1)
        CopyIconButton({
          colors: this.colors,
          copied: this.copied,
          description: 'Copy command',
          onTap: () => this.copy(),
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      Column().height(31)

      Scroll() {
        Column({ space: 4 }) {
          ForEach(bashCommandLines(this.command), (line: string, index: number) => {
            this.BashLine(line)
          }, (line: string, index: number) => `bash-${index}`)
        }
        .alignItems(HorizontalAlign.Start)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
    }
    .width('100%')
    .constraintSize({ minHeight: 112 })
    .borderRadius(20)
    .backgroundColor(this.palette().panel)
    .border({
      width: this.colors.isDark ? 1 : 0,
      color: this.palette().border,
    })
    .shadow({ radius: 20, color: this.palette().shadow, offsetX: 0, offsetY: 0 })
    .padding({ left: 18, top: 17, right: 18, bottom: 18 })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  BashLine(line: string) {
    Row({ space: 7 }) {
      Text(bashPrompt(line))
        .fontSize(16)
        .lineHeight(22)
        .fontFamily('monospace')
        .fontWeight(FontWeight.Medium)
        .fontColor(this.palette().prompt)
        .maxLines(1)
      if (bashRest(line).length > 0) {
        Text(bashRest(line))
          .fontSize(16)
          .lineHeight(22)
          .fontFamily('monospace')
          .fontWeight(FontWeight.Medium)
          .fontColor(this.palette().command)
          .maxLines(1)
      }
    }
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * The copy affordance.
 *
 * Android's button is a 23dp box holding the `ic_copy_bash_command_*` bitmap, and
 * for 1100ms after a copy it swaps to a hand-drawn 14dp check glyph — which is the
 * one part that stays a vector, because Android draws it with a canvas path.
 */
@Component
export struct CopyIconButton {
  colors: AAColors = AA_LIGHT_COLORS;
  copied: boolean = false;
  /**
   * Android hardcodes these two descriptions as English literals
   * (`AgentMarkdownText.kt`: "Copy code" and "Copy command"), so the port keeps
   * the same two strings rather than inventing localized ones.
   */
  description: string = 'Copy code';
  onTap: () => void = () => {};

  build() {
    Column() {
      if (this.copied) {
        AAIcon({
          commands: AA_ICONS.CHECK,
          iconSize: 15,
          color: codePalette(this.colors).label,
        })
      } else {
        Image(this.colors.isDark ? $r('app.media.ic_copy_bash_command_dark')
          : $r('app.media.ic_copy_bash_command_light'))
          .width(23)
          .height(23)
          .objectFit(ImageFit.Contain)
      }
    }
    .width(23)
    .height(23)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(this.description)
    .onClick(() => this.onTap())
  }
}

/** The first word of a command, which Android draws in the prompt colour. */
export function bashPrompt(line: string): string {
  const command: string = line.trim();
  const space: number = command.indexOf(' ');
  return space < 0 ? command : command.substring(0, space);
}

/** Everything after the first word. */
export function bashRest(line: string): string {
  const command: string = line.trim();
  const space: number = command.indexOf(' ');
  return space < 0 ? '' : command.substring(space + 1).replace(/^\s+/, '');
}
