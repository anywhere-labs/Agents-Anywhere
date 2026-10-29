import { common, OpenLinkOptions } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { MdBlock, MdSpan, mdTextHash } from 'common';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { RadiusTokens } from 'common';
import { showToast } from 'common';

function mdBlockKey(block: MdBlock, index: number): string {
  let content = `${block.kind}|${block.language}|${block.codeText}`;
  if (block.table !== undefined) {
    content += block.table.header.join('|');
    for (const row of block.table.rows) {
      content += row.join('|');
    }
  }
  for (const span of block.spans) {
    content += span.text;
    if (span.linkUrl !== null) {
      content += span.linkUrl;
    }
    if (span.path !== null) {
      content += span.path;
    }
  }
  return `${index}_${mdTextHash(content)}`;
}

function mdSpanKey(span: MdSpan, index: number): string {
  let content = span.text;
  if (span.linkUrl !== null) {
    content += span.linkUrl;
  }
  if (span.path !== null) {
    content += span.path;
  }
  return `${index}_${mdTextHash(content)}`;
}

function mdAlignToTextAlign(align: string): TextAlign {
  if (align === 'left') {
    return TextAlign.Start;
  }
  if (align === 'center') {
    return TextAlign.Center;
  }
  if (align === 'right') {
    return TextAlign.End;
  }
  return TextAlign.Start;
}

@Component
export struct AgentMarkdownView {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop blocks: MdBlock[] = [];
  @Prop textColor: string = '';
  @Prop linkColor: string = '';
  @Prop inlineCodeColor: string = '';
  @Prop codePanelColor: string = '';
  @Prop codePanelTextColor: string = '';
  @Prop fontSize: number = 17;
  // Absolute content width cap in vp. -1 disables the cap. Percent-based
  // maxWidth inside a constraintSize'd ancestor resolves against the window
  // instead of the bubble, so chat bubbles must pass an explicit vp cap.
  @Prop contentMaxWidthVp: number = -1;

  private contentWidthCap(): number {
    return this.contentMaxWidthVp > 0 ? this.contentMaxWidthVp : 100000;
  }

  private isCompact(): boolean {
    return this.fontSize < 17;
  }

  private bodyLineHeight(): number {
    return this.isCompact() ? 21 : 27;
  }

  private headingFontSize(level: number): number {
    if (this.isCompact()) {
      if (level <= 1) {
        return 17;
      }
      if (level === 2) {
        return 16;
      }
      return 15;
    }
    if (level <= 1) {
      return 22;
    }
    if (level === 2) {
      return 20;
    }
    return 18;
  }

  private headingLineHeight(level: number): number {
    if (this.isCompact()) {
      if (level <= 1) {
        return 24;
      }
      if (level === 2) {
        return 23;
      }
      return 22;
    }
    if (level <= 1) {
      return 30;
    }
    if (level === 2) {
      return 28;
    }
    return 26;
  }

  private headingFontWeight(): number {
    return this.isCompact() ? 600 : 700;
  }

  private tableCellFontSize(): number {
    return this.isCompact() ? 13 : 14.5;
  }

  private tableCellLineHeight(): number {
    return this.isCompact() ? 19 : 22;
  }

  private resolvedTextColor(): string {
    if (this.textColor.length > 0) {
      return this.textColor;
    }
    return getColors().sessionMessageText;
  }

  private resolvedLinkColor(): string {
    if (this.linkColor.length > 0) {
      return this.linkColor;
    }
    return getColors().mdLinkOnPrimary;
  }

  private resolvedInlineCodeColor(): string {
    if (this.inlineCodeColor.length > 0) {
      return this.inlineCodeColor;
    }
    return getColors().sessionMessageText;
  }

  private resolvedCodePanelColor(): string {
    if (this.codePanelColor.length > 0) {
      return this.codePanelColor;
    }
    return getColors().mdCodeOnSurface;
  }

  private resolvedCodePanelTextColor(): string {
    if (this.codePanelTextColor.length > 0) {
      return this.codePanelTextColor;
    }
    return getColors().mdCodePanelText;
  }

  private listMarkerText(block: MdBlock): string {
    if (block.ordered) {
      return `${block.itemNumber}.`;
    }
    if (block.taskChecked !== undefined) {
      return block.taskChecked ? '[x]' : '[ ]';
    }
    return '•';
  }

  private listMarkerFontFamily(block: MdBlock): string {
    if (block.taskChecked !== undefined) {
      return 'monospace';
    }
    return '';
  }

  private spanFontWeight(span: MdSpan): FontWeight {
    return span.bold ? FontWeight.Bold : FontWeight.Normal;
  }

  private spanFontSize(span: MdSpan): number {
    if (span.code) {
      return 14;
    }
    return this.fontSize;
  }

  private spanFontColor(span: MdSpan): string {
    if (span.linkUrl !== null) {
      return this.resolvedLinkColor();
    }
    if (span.path !== null) {
      return this.resolvedLinkColor();
    }
    if (span.code) {
      return this.resolvedInlineCodeColor();
    }
    return this.resolvedTextColor();
  }

  private spanFontStyle(span: MdSpan): FontStyle {
    return span.italic ? FontStyle.Italic : FontStyle.Normal;
  }

  private spanDecorationType(span: MdSpan): TextDecorationType {
    if (span.strike) {
      return TextDecorationType.LineThrough;
    }
    if (span.linkUrl !== null || span.path !== null) {
      return TextDecorationType.Underline;
    }
    return TextDecorationType.None;
  }

  private spanFontFamily(span: MdSpan): string {
    if (span.code) {
      return 'monospace';
    }
    return '';
  }

  private openUrl(url: string): void {
    const options: OpenLinkOptions = { appLinkingOnly: false };
    try {
      const context = getContext(this) as common.UIAbilityContext;
      context.openLink(url, options).catch(() => {
        showToast(`Open this address in your browser: ${url}`);
      });
    } catch (error) {
      showToast(`Open this address in your browser: ${url}`);
    }
  }

  @Builder
  spanContent(spans: MdSpan[]) {
    ForEach(spans, (span: MdSpan, index: number) => {
      Span(span.text)
        .fontWeight(this.spanFontWeight(span))
        .fontSize(this.spanFontSize(span))
        .fontColor(this.spanFontColor(span))
        .fontStyle(this.spanFontStyle(span))
        .decoration({ type: this.spanDecorationType(span) })
        .fontFamily(this.spanFontFamily(span))
        .onClick(() => {
          if (span.linkUrl !== null) {
            this.openUrl(span.linkUrl);
          } else if (span.path !== null) {
            showToast(`Path copied: ${span.path}`);
            const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, span.path);
            pasteboard.getSystemPasteboard().setData(data);
          }
        })
    }, (span: MdSpan, index: number) => mdSpanKey(span, index))
  }

  @Builder
  tableRow(cells: string[], aligns: string[], isHeader: boolean) {
    Row() {
      ForEach(cells, (cell: string, colIndex: number) => {
        Text(cell)
          .fontSize(this.tableCellFontSize())
          .lineHeight(this.tableCellLineHeight())
          .fontWeight(isHeader ? 700 : 400)
          .fontColor(this.resolvedTextColor())
          .textAlign(mdAlignToTextAlign(aligns[colIndex] ?? ''))
          .padding({ left: 10, right: 10, top: 8, bottom: 8 })
          .layoutWeight(1)
      }, (cell: string, colIndex: number) => `${colIndex}_${mdTextHash(cell)}`)
    }
      .width('100%')
      .constraintSize({ maxWidth: this.contentWidthCap() })
      .border({ width: { bottom: 1 }, color: getColors().border })
      .backgroundColor(isHeader ? getColors().subtle : 'transparent')
  }

  @Builder
  blockView(block: MdBlock, index: number) {
    if (block.kind === 'code') {
      MdCodePanelView({
        codeText: block.codeText,
        language: block.language,
        panelColor: this.resolvedCodePanelColor(),
        panelTextColor: this.resolvedCodePanelTextColor(),
        contentMaxWidthVp: this.contentMaxWidthVp
      })
    } else if (block.kind === 'heading') {
      Text() {
        this.spanContent(block.spans)
      }
      .fontSize(this.headingFontSize(block.level))
      .lineHeight(this.headingLineHeight(block.level))
      .fontWeight(this.headingFontWeight())
      .constraintSize({ maxWidth: this.contentWidthCap() })
    } else if (block.kind === 'table') {
      if (block.table !== undefined) {
        Column() {
          this.tableRow(block.table.header, block.table.aligns, true)
          ForEach(block.table.rows, (row: string[], rowIndex: number) => {
            this.tableRow(row, block.table!.aligns, false)
          }, (row: string[], rowIndex: number) => `${rowIndex}_${mdTextHash(row.join('|'))}`)
        }
        .width('100%')
        .constraintSize({ maxWidth: this.contentWidthCap() })
        .border({ width: 1, color: getColors().border })
        .borderRadius(8)
      }
    } else if (block.kind === 'quote') {
      Column() {
        AgentMarkdownView({
          blocks: block.children,
          textColor: getColors().muted,
          linkColor: this.linkColor,
          inlineCodeColor: this.inlineCodeColor,
          codePanelColor: this.codePanelColor,
          codePanelTextColor: this.codePanelTextColor,
          fontSize: this.fontSize,
          contentMaxWidthVp: this.contentMaxWidthVp
        })
      }
      .width('100%')
      .constraintSize({ maxWidth: this.contentWidthCap() })
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 10, top: 2, bottom: 2 })
      .border({ width: { left: 2 }, color: getColors().border })
    } else if (block.kind === 'listItem') {
      Row({ space: 8 }) {
        Text(this.listMarkerText(block))
          .fontSize(16)
          .lineHeight(24)
          .fontColor(getColors().muted)
          .fontFamily(this.listMarkerFontFamily(block))
        Text() {
          this.spanContent(block.spans)
        }
        .fontSize(this.fontSize)
        .lineHeight(this.bodyLineHeight())
        .layoutWeight(1)
        .constraintSize({ maxWidth: this.contentWidthCap() })
      }
      .width('100%')
      .constraintSize({ maxWidth: this.contentWidthCap() })
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === 'rule') {
      Divider()
        .color(getColors().border)
        .width('100%')
        .constraintSize({ maxWidth: this.contentWidthCap() })
    } else {
      Text() {
        this.spanContent(block.spans)
      }
      .fontSize(this.fontSize)
      .lineHeight(this.bodyLineHeight())
      .constraintSize({ maxWidth: this.contentWidthCap() })
    }
  }

  build() {
    Column({ space: this.isCompact() ? 6 : 8 }) {
      ForEach(this.blocks, (block: MdBlock, index: number) => {
        this.blockView(block, index)
      }, (block: MdBlock, index: number) => mdBlockKey(block, index))
    }
    .constraintSize({ maxWidth: this.contentWidthCap() })
    .alignItems(HorizontalAlign.Start)
  }
}

@Component
export struct MdCodePanelView {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop codeText: string = '';
  @Prop language: string = '';
  @Prop panelColor: string = '';
  @Prop panelTextColor: string = '';
  @Prop contentMaxWidthVp: number = -1;

  private contentWidthCap(): number {
    return this.contentMaxWidthVp > 0 ? this.contentMaxWidthVp : 100000;
  }
  @State copied: boolean = false;

  private codeLabel(): string {
    if (this.language.length > 0) {
      return this.language;
    }
    return 'code';
  }

  private labelColor(): string {
    return this.themeIsDark ? '#FAFAFA' : '#191A18';
  }

  private resolvedPanelColor(): string {
    if (this.panelColor.length > 0) {
      return this.panelColor;
    }
    return getColors().mdCodeOnSurface;
  }

  private resolvedPanelTextColor(): string {
    if (this.panelTextColor.length > 0) {
      return this.panelTextColor;
    }
    return getColors().mdCodePanelText;
  }

  private copySymbol(): Resource {
    return this.copied ? $r('sys.symbol.checkmark') : $r('sys.symbol.doc_plaintext');
  }

  private copyCode(): void {
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.codeText);
    pasteboard.getSystemPasteboard().setData(data)
      .then(() => {
        this.copied = true;
        setTimeout(() => {
          this.copied = false;
        }, 1100);
      })
      .catch(() => {
      });
  }

  build() {
    Column({ space: 14 }) {
      Row() {
        Text(this.codeLabel())
          .fontSize(14)
          .lineHeight(18)
          .fontWeight(700)
          .fontColor(this.labelColor())
          .layoutWeight(1)
        SymbolGlyph(this.copySymbol())
          .fontSize(23)
          .width(23)
          .height(23)
          .fontColor([this.labelColor()])
          .onClick(() => {
            this.copyCode();
          })
      }
      .width('100%')
      .constraintSize({ maxWidth: this.contentWidthCap() })
      Text(this.codeText)
        .fontSize(12)
        .fontFamily('monospace')
        .fontColor(this.resolvedPanelTextColor())
        .constraintSize({ maxWidth: this.contentWidthCap() })
        .textAlign(TextAlign.Start)
        .copyOption(CopyOptions.InApp)
    }
    .width('100%')
    .constraintSize({ maxWidth: this.contentWidthCap(), minHeight: 112 })
    .borderRadius(RadiusTokens.codePanel)
    .backgroundColor(this.resolvedPanelColor())
    .border({ width: this.themeIsDark ? 1 : 0, color: '#27272A' })
    .padding({ left: 18, right: 18, top: 17, bottom: 12 })
  }
}
