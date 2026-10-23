import {
  MarkdownAlignment, MarkdownBlock, MarkdownBlockKind, MarkdownInline, parseMarkdown,
} from '../../../feature/sessiondetail/MarkdownParser';
import { bashCommandLines } from '../../../feature/sessiondetail/CodeTokenizer';
import { isBashLanguage } from '../../../feature/sessiondetail/CodeLanguage';
import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { BashCommandCard, CodeBlockPanel } from './CodeBlockPanel';

/**
 * Markdown renderer.
 *
 * Port of `ui/screens/sessiondetail/AgentMarkdownText.kt`.
 *
 * The Android client renders with commonmark plus a Compose layout; here the
 * parser produces blocks and this component draws them, so the type scale and
 * the style tokens stay identical.
 *
 * Typography, from Android: body 17sp/27sp, headings 22/20/18sp with
 * 30/28/26sp line height, links `#EBB353` underlined, inline code monospace on
 * the code surface. `compact` (used for reasoning) drops to 14sp/21sp.
 *
 * Code fences are drawn by `CodeBlockPanel` (or, for bash labels, by one
 * `BashCommandCard` per non-blank line), with tokens from the self-authored
 * `CodeTokenizer`.
 *
 * List markers are drawn with the vector icon set rather than Unicode bullets,
 * which removes the only non-ASCII characters from this file.
 *
 * Not yet drawn: tapping a file reference to open the workspace browser.
 */

/** Inline code is mangled by the surrounding line height, so it gets its own size. */
const CODE_FONT_SIZE: number = 14;

@Component
export struct AgentMarkdownText {
  colors: AAColors = AA_LIGHT_COLORS;
  text: string = '';
  /** Dropped to the reasoning scale: 14sp/21sp with lighter body weight. */
  compact: boolean = false;

  private blocks(): MarkdownBlock[] {
    if (this.text.trim().length === 0) {
      return [];
    }
    return parseMarkdown(this.text);
  }

  private bodySize(): number {
    return this.compact ? 14 : 17;
  }

  private bodyLineHeight(): number {
    return this.compact ? 21 : 27;
  }

  private bodyColor(): string {
    return this.colors.isDark ? '#EDEDEF' : '#242522';
  }

  private mutedColor(): string {
    return this.colors.isDark ? '#A1A1AA' : '#7C7B76';
  }

  /** Named `hairlineColor` because `borderColor` collides with the component modifier. */
  private hairlineColor(): string {
    return this.colors.isDark ? '#27272A' : '#E4E1DB';
  }

  private codeBackground(): string {
    return this.colors.isDark ? '#292929' : '#F1F0ED';
  }

  /** Link colour, identical in both themes on Android. */
  private linkColor(): string {
    return '#EBB353';
  }

  private headingSize(level: number): number {
    if (level <= 1) {
      return 22;
    }
    if (level === 2) {
      return 20;
    }
    return 18;
  }

  private headingLineHeight(level: number): number {
    if (level <= 1) {
      return 30;
    }
    if (level === 2) {
      return 28;
    }
    return 26;
  }

  build() {
    Column({ space: 12 }) {
      if (this.blocks().length === 0) {
        // Android renders an explicit placeholder rather than an empty bubble.
        Text('_(no content)_')
          .fontSize(this.bodySize())
          .fontColor(this.mutedColor())
      } else {
        ForEach(this.blocks(), (block: MarkdownBlock, index: number) => {
          this.Block(block)
        }, (block: MarkdownBlock, index: number) => `block-${index}`)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  Block(block: MarkdownBlock) {
    if (block.kind === MarkdownBlockKind.Heading) {
      this.InlineText(
        block.inlines,
        this.headingSize(block.level),
        this.headingLineHeight(block.level),
        FontWeight.Bold,
        this.colors.ink,
      )
    } else if (block.kind === MarkdownBlockKind.Paragraph) {
      this.InlineText(
        block.inlines,
        this.bodySize(),
        this.bodyLineHeight(),
        FontWeight.Normal,
        this.bodyColor(),
      )
    } else if (block.kind === MarkdownBlockKind.Blockquote) {
      Row({ space: 10 }) {
        Column()
          .width(2)
          .height('100%')
          .backgroundColor(this.hairlineColor())
        // A `@Builder` call returns void, so the weight goes on a wrapper.
        Column() {
          this.InlineText(
            block.inlines,
            this.bodySize(),
            this.bodyLineHeight(),
            FontWeight.Normal,
            this.mutedColor(),
          )
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === MarkdownBlockKind.ListItem) {
      this.ListItemRow(block)
    } else if (block.kind === MarkdownBlockKind.CodeBlock) {
      this.CodeBlock(block)
    } else if (block.kind === MarkdownBlockKind.ThematicBreak) {
      Divider().strokeWidth(1).color(this.hairlineColor()).width('100%')
    } else if (block.kind === MarkdownBlockKind.Table) {
      this.Table(block)
    }
  }

  @Builder
  ListItemRow(block: MarkdownBlock) {
    Row({ space: 8 }) {
      // Bullet, number, or a task check box.
      if (block.checked !== null) {
        AAIcon({
          commands: block.checked ? AA_ICONS.CIRCLE_CHECK : AA_ICONS.CIRCLE,
          iconSize: 16,
          color: block.checked ? this.colors.sessionStatusAccent : this.mutedColor(),
        })
      } else if (block.ordered) {
        Text(block.marker)
          .fontSize(this.bodySize())
          .fontColor(this.mutedColor())
          .constraintSize({ minWidth: 22 })
      } else {
        Column()
          .width(5)
          .height(5)
          .borderRadius(3)
          .backgroundColor(this.mutedColor())
          .margin({ top: this.compact ? 8 : 11 })
          .constraintSize({ minWidth: 12 })
      }
      Column() {
        this.InlineText(
          block.inlines,
          this.bodySize(),
          this.bodyLineHeight(),
          FontWeight.Normal,
          this.bodyColor(),
        )
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 14 * block.depth })
    .alignItems(VerticalAlign.Top)
  }

  /**
   * A code fence.
   *
   * A bash label becomes one card per non-blank line, each carrying its own copy
   * button; everything else is one panel with a line-numbered, highlighted body.
   * The empty case matches Android's `ifEmpty { listOf(code) }`: a blank bash
   * fence still draws a single card.
   */
  @Builder
  CodeBlock(block: MarkdownBlock) {
    if (isBashLanguage(block.language)) {
      Column({ space: 10 }) {
        ForEach(this.bashCommands(block.code), (command: string, index: number) => {
          BashCommandCard({
            colors: this.colors,
            label: 'Bash',
            command: command,
          })
        }, (command: string, index: number) => `bash-${index}`)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    } else {
      CodeBlockPanel({
        colors: this.colors,
        label: block.language.length > 0 ? block.language : 'code',
        code: block.code,
      })
    }
  }

  private bashCommands(code: string): string[] {
    const commands: string[] = bashCommandLines(code);
    return commands.length === 0 ? [code] : commands;
  }

  @Builder
  Table(block: MarkdownBlock) {
    Scroll() {
      Column() {
        Row() {
          ForEach(block.header, (cell: MarkdownInline[], cellIndex: number) => {
            this.TableCell(cell, true)
          }, (cell: MarkdownInline[], cellIndex: number) => `head-${cellIndex}`)
        }
        ForEach(block.rows, (row: MarkdownInline[][], rowIndex: number) => {
          Row() {
            ForEach(row, (cell: MarkdownInline[], cellIndex: number) => {
              this.TableCell(cell, false)
            }, (cell: MarkdownInline[], cellIndex: number) => `cell-${rowIndex}-${cellIndex}`)
          }
        }, (row: MarkdownInline[][], rowIndex: number) => `row-${rowIndex}`)
      }
      .alignItems(HorizontalAlign.Start)
      .borderRadius(8)
      .border({ width: 1, color: this.hairlineColor() })
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .borderRadius(8)
  }

  @Builder
  TableCell(cell: MarkdownInline[], header: boolean) {
    Column() {
      this.InlineText(
        cell,
        this.compact ? 13 : 14.5,
        this.compact ? 19 : 22,
        header ? FontWeight.Bold : FontWeight.Normal,
        this.bodyColor(),
      )
    }
    .constraintSize({ minWidth: 112, maxWidth: 240 })
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .backgroundColor(header ? withAlpha(this.codeBackground(), 0.9) : '#00000000')
    .border({ width: 0.5, color: this.hairlineColor() })
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * Renders a run list as one `Text` with styled `Span` children.
   *
   * A single `Text` keeps line breaking and line height identical to a plain
   * paragraph, which a row of separate `Text` components would not.
   */
  @Builder
  InlineText(
    runs: MarkdownInline[],
    size: number,
    lineHeight: number,
    weight: FontWeight,
    defaultColor: string,
  ) {
    Text() {
      ForEach(runs, (run: MarkdownInline, index: number) => {
        Span(run.text)
          .fontSize(run.code ? CODE_FONT_SIZE : size)
          .fontFamily(run.code ? 'monospace' : '')
          .fontWeight(run.bold ? FontWeight.Bold : weight)
          .fontStyle(run.italic ? FontStyle.Italic : FontStyle.Normal)
          .fontColor(this.runColor(run, defaultColor))
          .textBackgroundStyle({
            color: run.code ? this.codeBackground() : '#00000000',
            radius: 4,
          })
          .decoration({
            type: run.strike
              ? TextDecorationType.LineThrough
              : (run.link !== null || run.fileRef
                ? TextDecorationType.Underline
                : TextDecorationType.None),
            color: this.runColor(run, defaultColor),
          })
      }, (run: MarkdownInline, index: number) => `run-${index}`)
    }
    .fontSize(size)
    .lineHeight(lineHeight)
    .width('100%')
  }

  private runColor(run: MarkdownInline, defaultColor: string): string {
    if (run.link !== null || run.fileRef) {
      return this.linkColor();
    }
    return defaultColor;
  }
}
