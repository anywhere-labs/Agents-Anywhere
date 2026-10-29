/*
 * Expanded detail panel for one tool row (round 21 redesign).
 *
 * Mirrors web ToolDetailPanel: a command block, file-change rows (action tag +
 * display path + optional diff) and a clamped output block, each with a copy
 * affordance. Rendered inside TimelineToolEntry when a row is expanded.
 */

import { pasteboard } from '@kit.BasicServicesKit';
import { RemoteTimelineFileChange } from 'network';
import { displayPathFor, fileChangeActionOf } from '../../common/TimelineSummaries';
import { getColors } from 'common';
import { DiffCodeView } from '../DiffCodeView';
import { showToast } from 'common';

const OUTPUT_MAX_HEIGHT_VP = 260;
const CHANGE_DIFF_MAX_HEIGHT_VP = 300;

@Component
export struct TimelineToolPanel {
  @Prop commandText: string = '';
  @Prop outputText: string = '';
  @Prop changes: RemoteTimelineFileChange[] = [];
  @Prop workingDir: string = '';
  @Prop contentMaxWidthVp: number = -1;

  private copyToClipboard(text: string): void {
    try {
      const data = pasteboard.createPlainTextData(text);
      pasteboard.getSystemPasteboard().setData(data);
      showToast($r('app.string.session_tool_copied'));
    } catch (error) {
      // Swallowed: a failed clipboard write must never break the row.
    }
  }

  private actionLabelResource(action: string): Resource {
    if (action === 'created') {
      return $r('app.string.session_tool_action_created');
    }
    if (action === 'deleted') {
      return $r('app.string.session_tool_action_deleted');
    }
    if (action === 'renamed') {
      return $r('app.string.session_tool_action_renamed');
    }
    if (action === 'modified') {
      return $r('app.string.session_tool_action_modified');
    }
    return $r('app.string.session_tool_action_changed');
  }

  @Builder
  private commandPanel() {
    Column() {
      Row() {
        Text($r('app.string.session_tool_label_command'))
          .fontSize(11)
          .fontColor(getColors().muted)
          .layoutWeight(1)
        Text($r('app.string.session_tool_copy'))
          .fontSize(11)
          .fontColor(getColors().muted)
          .padding({ left: 8, top: 2, bottom: 2 })
          .onClick(() => {
            this.copyToClipboard(this.commandText);
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      Text(this.commandText)
        .fontSize(12)
        .fontFamily('monospace')
        .fontColor(getColors().inkSoft)
        .width('100%')
        .padding({ left: 10, right: 10, top: 8, bottom: 8 })
        .borderRadius(8)
        .backgroundColor(getColors().sessionCodeSurface)
        .copyOption(CopyOptions.LocalDevice)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private outputPanel() {
    Column() {
      Row() {
        Text($r('app.string.session_tool_label_output'))
          .fontSize(11)
          .fontColor(getColors().muted)
          .layoutWeight(1)
        Text($r('app.string.session_tool_copy'))
          .fontSize(11)
          .fontColor(getColors().muted)
          .padding({ left: 8, top: 2, bottom: 2 })
          .onClick(() => {
            this.copyToClipboard(this.outputText);
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      Scroll() {
        Text(this.outputText)
          .fontSize(12)
          .fontFamily('monospace')
          .fontColor(getColors().inkSoft)
          .width('100%')
          .padding({ left: 10, right: 10, top: 8, bottom: 8 })
          .copyOption(CopyOptions.LocalDevice)
      }
      .scrollable(ScrollDirection.Vertical)
      .scrollBar(BarState.Auto)
      .width('100%')
      .constraintSize({ maxHeight: OUTPUT_MAX_HEIGHT_VP })
      .align(Alignment.Top)
      .borderRadius(8)
      .backgroundColor(getColors().sessionCodeSurface)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private fileChangeRow(change: RemoteTimelineFileChange) {
    Column() {
      Row({ space: 6 }) {
        SymbolGlyph($r('sys.symbol.doc_text'))
          .fontSize(14)
          .fontColor([getColors().muted])
        Text(this.actionLabelResource(fileChangeActionOf(change)))
          .fontSize(11)
          .fontColor(getColors().inkSoft)
          .padding({ left: 6, right: 6, top: 1, bottom: 1 })
          .borderRadius(4)
          .backgroundColor(getColors().subtle)
        Text(displayPathFor(change.path, this.workingDir.length > 0 ? this.workingDir : null))
          .fontSize(12)
          .fontColor(getColors().muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      if (change.diff !== null && change.diff.length > 0) {
        Scroll() {
          DiffCodeView({
            codeText: change.diff,
            contentMaxWidthVp: this.contentMaxWidthVp
          })
        }
        .scrollable(ScrollDirection.Vertical)
        .scrollBar(BarState.Auto)
        .width('100%')
        .constraintSize({ maxHeight: CHANGE_DIFF_MAX_HEIGHT_VP })
        .align(Alignment.Top)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: 8 }) {
      if (this.commandText.length > 0) {
        this.commandPanel()
      }
      if (this.changes.length > 0) {
        Column({ space: 8 }) {
          ForEach(this.changes, (change: RemoteTimelineFileChange) => {
            this.fileChangeRow(change)
          }, (change: RemoteTimelineFileChange) =>
            `${change.path}_${change.action}_${change.diff === null ? 0 : change.diff.length}`)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      if (this.outputText.length > 0) {
        this.outputPanel()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(10)
    .borderRadius(12)
    .backgroundColor(getColors().canvas)
    .border({ width: 1, color: getColors().border })
  }
}
