/*
 * Weak single-line tool row for the session timeline (round 21 redesign).
 *
 * Mirrors web ToolMarkerRowContent: a quiet icon + humanized title line that
 * shows a spinner while running and turns red on failure. Rows with detail
 * expand in place — reasoning rows reveal their full text, other rows reveal
 * the TimelineToolPanel. The expand state lives in this component so page
 * rebuilds do not need to track it.
 */

import {
  TimelineToolRowModel,
  emptyTimelineToolRowModel,
  timelineKindSymbol
} from '../../common/TimelineSummaries';
import { getColors } from 'common';
import { TimelineToolPanel } from './TimelineToolPanel';

const REASONING_TEXT_MAX_HEIGHT_VP = 260;

@Component
export struct TimelineToolEntry {
  @Prop model: TimelineToolRowModel = emptyTimelineToolRowModel();
  @Prop workingDir: string = '';
  @Prop contentMaxWidthVp: number = -1;
  @State rowOpen: boolean = false;

  build() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        if (this.model.hasDetail) {
          SymbolGlyph($r('sys.symbol.chevron_down'))
            .fontSize(12)
            .fontColor([getColors().faint])
            .rotate({ angle: this.rowOpen ? 0 : -90 })
        }
        SymbolGlyph(this.model.failed ? $r('sys.symbol.exclamationmark_circle') :
          timelineKindSymbol(this.model.kind))
          .fontSize(14)
          .fontColor([this.model.failed ? getColors().errorText : getColors().muted])
        Text(this.model.title)
          .fontSize(13)
          .fontColor(this.model.failed ? getColors().errorText : getColors().muted)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.model.running) {
          LoadingProgress()
            .width(12)
            .height(12)
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        if (this.model.hasDetail) {
          this.rowOpen = !this.rowOpen;
        }
      })
      if (this.rowOpen) {
        if (this.model.kind === 'reasoning') {
          Scroll() {
            Text(this.model.text)
              .fontSize(13)
              .lineHeight(19)
              .fontColor(getColors().muted)
              .width('100%')
              .padding({ left: 20, right: 4 })
              .copyOption(CopyOptions.LocalDevice)
          }
          .scrollable(ScrollDirection.Vertical)
          .scrollBar(BarState.Auto)
          .width('100%')
          .constraintSize({ maxHeight: REASONING_TEXT_MAX_HEIGHT_VP })
          .align(Alignment.Top)
        } else {
          TimelineToolPanel({
            commandText: this.model.command,
            outputText: this.model.output,
            changes: this.model.changes,
            workingDir: this.workingDir,
            contentMaxWidthVp: this.contentMaxWidthVp
          })
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
