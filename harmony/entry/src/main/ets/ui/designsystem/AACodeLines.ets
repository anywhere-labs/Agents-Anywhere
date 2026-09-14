import { AAColors, AA_LIGHT_COLORS } from './AAColors';
import { CodePalette, codePalette, tokenStyle } from './AACodeColors';
import { CodeLine, CodeTokenKind, normalizeCodeText, tokenizeCode } from '../../feature/sessiondetail/CodeTokenizer';
import { CodeLanguageSpec, codeLanguageFor } from '../../feature/sessiondetail/CodeLanguage';
import { CodeRenderSegment, FileMatch, codeLineSegments } from '../../feature/files/FileSearch';

/**
 * Highlighted, line-numbered code lines.
 *
 * The body shared by the markdown code panel and the file preview: a 12sp
 * monospace run at 15dp per line, a right-aligned gutter with no divider, and
 * horizontal scrolling for the code so the gutter stays put.
 *
 * `fixedHeight` mirrors Android's `fixedHeight` on the code panel (lines * 15 +
 * 12); passing 0 sizes the block to its content, which is what the file preview
 * wants inside its own scroll container.
 *
 * `matches` and `currentMatch` come from the file preview's in-file search; they
 * are empty and -1 everywhere else, which leaves the token spans untouched.
 */

export const CODE_SIZE: number = 12;
/** Exported because the file preview scrolls to a match by line arithmetic. */
export const CODE_LINE_HEIGHT: number = 15;
const GUTTER_INSET: number = 8;
/** Advance width of one 12sp monospace glyph, used to size the gutter. */
const MONOSPACE_ADVANCE: number = 7.2;

@Component
export struct CodeLinesView {
  colors: AAColors = AA_LIGHT_COLORS;
  /** Fence language or file name; drives which tokenizer rules apply. */
  label: string = 'code';
  code: string = '';
  /** 0 sizes to content; a positive value fixes the block height. */
  fixedHeight: number = 0;
  showGutter: boolean = true;
  topPadding: number = 8;
  /** In-file search matches, in source order; empty when no search is running. */
  matches: FileMatch[] = [];
  /** Index into `matches` of the match the jump is on, or -1. */
  currentMatch: number = -1;
  /**
   * Tokenization cache: `copied` and search state re-render these components, and
   * without the cache a long file would be re-scanned on every such frame.
   */
  private cachedCode: string = '';
  private cachedLanguage: string = '';
  private cachedSource: string = '';
  private cachedLines: CodeLine[] = [];

  private palette(): CodePalette {
    return codePalette(this.colors);
  }

  private language(): CodeLanguageSpec | null {
    return codeLanguageFor(this.label);
  }

  private lines(): CodeLine[] {
    const language: CodeLanguageSpec | null = this.language();
    const name: string = language === null ? '' : language.name;
    if (this.cachedCode !== this.code || this.cachedLanguage !== name) {
      this.cachedCode = this.code;
      this.cachedLanguage = name;
      this.cachedSource = normalizeCodeText(this.code);
      this.cachedLines = tokenizeCode(this.cachedSource, language).lines;
    }
    return this.cachedLines;
  }

  private lineCount(): number {
    const count: number = this.lines().length;
    return count < 1 ? 1 : count;
  }

  private blockHeight(): number {
    return this.fixedHeight > 0 ? this.fixedHeight : this.lineCount() * CODE_LINE_HEIGHT + 12;
  }

  private gutterWidth(): number {
    let digits: number = 1;
    let value: number = this.lineCount();
    while (value >= 10) {
      digits++;
      value = Math.floor(value / 10);
    }
    return GUTTER_INSET * 2 + Math.ceil(digits * MONOSPACE_ADVANCE);
  }

  build() {
    Row() {
      if (this.showGutter) {
        this.Gutter()
      }
      Scroll() {
        Column() {
          ForEach(this.lines(), (line: CodeLine, index: number) => {
            this.CodeLineRow(line, index)
          }, (line: CodeLine, index: number) => `code-${index}`)
        }
        .alignItems(HorizontalAlign.Start)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .align(Alignment.TopStart)
    }
    .width('100%')
    .height(this.blockHeight())
    .padding({ top: this.topPadding })
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  Gutter() {
    Column() {
      ForEach(this.lines(), (line: CodeLine, index: number) => {
        Text(`${index + 1}`)
          .fontSize(CODE_SIZE)
          .lineHeight(CODE_LINE_HEIGHT)
          .height(CODE_LINE_HEIGHT)
          .fontFamily('monospace')
          .fontColor(this.palette().lineNumber)
          .textAlign(TextAlign.End)
          .width('100%')
      }, (line: CodeLine, index: number) => `gutter-${index}`)
    }
    .width(this.gutterWidth())
    .padding({ left: GUTTER_INSET, right: GUTTER_INSET })
    .alignItems(HorizontalAlign.End)
  }

  @Builder
  CodeLineRow(line: CodeLine, index: number) {
    if (line.spans.length === 0) {
      Text(' ')
        .fontSize(CODE_SIZE)
        .lineHeight(CODE_LINE_HEIGHT)
        .height(CODE_LINE_HEIGHT)
        .fontFamily('monospace')
    } else {
      Text() {
        ForEach(
          codeLineSegments(index, line, this.matches, this.currentMatch),
          (segment: CodeRenderSegment) => {
            Span(segment.text)
              .fontColor(tokenStyle(this.palette(), segment.kind).color)
              .fontWeight(tokenStyle(this.palette(), segment.kind).bold
                ? FontWeight.Bold : FontWeight.Normal)
              .fontStyle(tokenStyle(this.palette(), segment.kind).italic
                ? FontStyle.Italic : FontStyle.Normal)
              .textBackgroundStyle({
                color: this.segmentBackground(segment),
              })
          },
          (segment: CodeRenderSegment, position: number) => `segment-${index}-${position}`,
        )
      }
      .fontSize(CODE_SIZE)
      .lineHeight(CODE_LINE_HEIGHT)
      .height(CODE_LINE_HEIGHT)
      .fontFamily('monospace')
      .fontColor(tokenStyle(this.palette(), CodeTokenKind.Plain).color)
    }
  }

  /**
   * The highlight behind one rendered segment.
   *
   * Everything that is not inside a match stays transparent, so the token colours
   * are the only thing painting ordinary text.
   */
  private segmentBackground(segment: CodeRenderSegment): string {
    if (!segment.highlighted) {
      return '#00000000';
    }
    return segment.current ? this.palette().searchMatchCurrent : this.palette().searchMatch;
  }
}
