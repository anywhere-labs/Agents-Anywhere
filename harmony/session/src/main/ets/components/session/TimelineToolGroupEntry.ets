/*
 * Collapsed group of consecutive tool-like rows (round 21 redesign).
 *
 * Mirrors web ToolRunGroup: runs of two or more tool-like timeline items
 * collapse behind a summary line ("Reasoned N times, Used tools M times")
 * with a spinner while any member is running; expanding reveals the member
 * rows, each an independent TimelineToolEntry.
 */

import {
  TimelineToolGroupModel,
  TimelineToolRowModel,
  emptyTimelineToolGroupModel
} from '../../common/TimelineSummaries';
import { getColors } from 'common';
import { TimelineToolEntry } from './TimelineToolEntry';

@Component
export struct TimelineToolGroupEntry {
  @Prop group: TimelineToolGroupModel = emptyTimelineToolGroupModel();
  @Prop workingDir: string = '';
  @Prop contentMaxWidthVp: number = -1;
  @State groupOpen: boolean = false;

  build() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(12)
          .fontColor([getColors().faint])
          .rotate({ angle: this.groupOpen ? 0 : -90 })
        SymbolGlyph($r('sys.symbol.line_3_horizontal'))
          .fontSize(14)
          .fontColor([getColors().muted])
        Text(this.group.summary)
          .fontSize(13)
          .fontColor(getColors().muted)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.group.running) {
          LoadingProgress()
            .width(12)
            .height(12)
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.groupOpen = !this.groupOpen;
      })
      if (this.groupOpen) {
        Column({ space: 8 }) {
          ForEach(this.group.members, (member: TimelineToolRowModel) => {
            TimelineToolEntry({
              model: member,
              workingDir: this.workingDir,
              contentMaxWidthVp: this.contentMaxWidthVp
            })
          }, (member: TimelineToolRowModel) => member.rowKey)
        }
        .width('100%')
        .padding({ left: 14 })
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
