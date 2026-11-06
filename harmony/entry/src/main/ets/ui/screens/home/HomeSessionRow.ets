import { AgentSession, SessionStatus } from '../../../model/AgentSession';
import { AAColors, AA_LIGHT_COLORS, sidebarSelectionFill, withAlpha } from '../../designsystem/AAColors';
import { SessionListIndicator, sessionDisplayTitle, sessionListIndicator } from '../../../feature/sessions/SessionMappers';
import { AARowArea } from './HomeSessionActions';

/**
 * Session list rows and their status indicator.
 *
 * Originally a port of the row composables in `ui/screens/home/HomeLists.kt`;
 * restyled in round 40 to the iOS sidebar's row language
 * (`ChatSidebarView.swift`'s `ChatSidebarSessionRow` / `ChatSidebarSessionIndicator`):
 * a 42dp row inset 10dp, the title at body size, and the state as a trailing
 * mint capsule, mini spinner or green dot. Android's leading 20dp cell and its
 * row hairlines are gone — iOS spaces its rows instead of ruling them.
 *
 * Rows still report their own bounds on layout, so the long-press overlay can
 * redraw the pressed row in place and float the action card beside it.
 */

/**
 * The bare status indicator: approval pill, busy spinner, unread dot.
 *
 * Restyled in round 40 to iOS's `ChatSidebarSessionIndicator`: an 11sp mint
 * capsule while a session waits for the user, a 14dp mini spinner while it runs,
 * an 8dp green dot when unread, and nothing otherwise.
 */
@Component
export struct SessionStatusIndicator {
  colors: AAColors = AA_LIGHT_COLORS;
  indicator: SessionListIndicator = SessionListIndicator.None;

  build() {
    if (this.indicator === SessionListIndicator.WaitingApproval) {
      Text($r('app.string.home_session_status_waiting_approval'))
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.colors.sessionStatusAccent)
        .maxLines(1)
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .borderRadius(999)
        .backgroundColor(withAlpha(this.colors.sessionStatusAccent, 0.16))
    } else if (this.indicator === SessionListIndicator.Busy) {
      LoadingProgress()
        .width(14)
        .height(14)
        .color(this.colors.ink)
    } else if (this.indicator === SessionListIndicator.Unread) {
      Column()
        .width(8)
        .height(8)
        .borderRadius(999)
        .backgroundColor(this.colors.sessionStatusAccent)
    }
  }
}

/**
 * Trailing cell of a flat row.
 *
 * iOS's session row ends with the indicator alone; this app also shows the age,
 * because its rows have no detail pane to carry it. Waiting-for-approval rows
 * show the pill in place of the age, as `SessionRowTrailing` does.
 */
@Component
export struct SessionRowTrailing {
  colors: AAColors = AA_LIGHT_COLORS;
  session: AgentSession = EMPTY_SESSION;
  indicator: SessionListIndicator = SessionListIndicator.None;

  build() {
    Row({ space: 8 }) {
      if (this.indicator !== SessionListIndicator.WaitingApproval) {
        Text(this.session.updatedAtLabel.length > 0 ? this.session.updatedAtLabel : 'now')
          .fontSize(12)
          .fontColor(this.colors.muted)
          .fontFamily('monospace')
          .maxLines(1)
      }

      SessionStatusIndicator({ colors: this.colors, indicator: this.indicator })
    }
    .alignItems(VerticalAlign.Center)
  }
}

/** One row in the flat "Pinned"/"Recents" list. */
@Component
export struct HomeSessionRow {
  colors: AAColors = AA_LIGHT_COLORS;
  session: AgentSession = EMPTY_SESSION;
  /** Pinned rows carry a context subtitle, so they are taller. */
  showSubtitle: boolean = false;
  /**
   * Whether this is the session the detail page is showing.
   *
   * iOS's `ChatSidebarSessionRow` takes `isSelected` and paints
   * `sidebarSelectionFill` behind it, so the sidebar shows which conversation is
   * open. Nothing carried that here, so the list looked the same whichever
   * session had been opened.
   */
  @Prop selected: boolean = false;
  onOpen: (session: AgentSession) => void = () => {};
  onLongPress: (session: AgentSession, area: AARowArea) => void = () => {};

  private rowArea: AARowArea = { x: 0, y: 0, width: 0, height: 0 };

  build() {
    // iOS's `ChatSidebarSessionRow`: a 10dp inset, a 42dp minimum height (iOS
    // spaces its rows instead of ruling them) and the title at `body` size.
    Row({ space: 10 }) {
      Column({ space: 2 }) {
        Text(sessionDisplayTitle(this.session.title))
          .fontSize(17)
          .fontColor(this.colors.ink)
          .lineHeight(21)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.showSubtitle) {
          Text(this.session.metaLabel)
            .fontSize(12)
            .fontColor(this.colors.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      SessionRowTrailing({
        colors: this.colors,
        session: this.session,
        indicator: sessionListIndicator(this.session),
      })
    }
    .width('100%')
    .height(this.showSubtitle ? 56 : 42)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(sidebarSelectionFill(this.colors, this.selected))
    .borderRadius(9)
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      this.rowArea = toRowArea(newValue);
    })
    .gesture(
      GestureGroup(GestureMode.Exclusive,
        TapGesture().onAction(() => this.onOpen(this.session)),
        LongPressGesture().onAction(() => this.onLongPress(this.session, this.rowArea)),
      ),
    )
  }
}

/** A session nested under a project row: iOS's inset sidebar row. */
@Component
export struct HomeProjectSessionRow {
  colors: AAColors = AA_LIGHT_COLORS;
  session: AgentSession = EMPTY_SESSION;
  /**
   * Whether the row is indented past the project's folder glyph. iOS's `inset`;
   * the project view turns it off for pinned sessions listed on their own.
   */
  inset: boolean = true;
  /** Whether this is the session the detail page is showing; see `HomeSessionRow`. */
  @Prop selected: boolean = false;
  onOpen: (session: AgentSession) => void = () => {};
  onLongPress: (session: AgentSession, area: AARowArea) => void = () => {};

  private rowArea: AARowArea = { x: 0, y: 0, width: 0, height: 0 };

  build() {
    // iOS indents a nested session by 36dp and keeps the same 42dp minimum.
    Row({ space: 10 }) {
      Text(this.session.title)
        .fontSize(17)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SessionStatusIndicator({
        colors: this.colors,
        indicator: sessionListIndicator(this.session),
      })
    }
    .width('100%')
    .height(42)
    .padding({ left: this.inset ? 36 : 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(sidebarSelectionFill(this.colors, this.selected))
    .borderRadius(9)
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      this.rowArea = toRowArea(newValue);
    })
    .gesture(
      GestureGroup(GestureMode.Exclusive,
        TapGesture().onAction(() => this.onOpen(this.session)),
        LongPressGesture().onAction(() => this.onLongPress(this.session, this.rowArea)),
      ),
    )
  }
}

/** ArkUI reports lengths as `Length`; the overlay needs plain numbers. */
function toRowArea(area: Area): AARowArea {
  return {
    x: Number(area.globalPosition.x),
    y: Number(area.globalPosition.y),
    width: Number(area.width),
    height: Number(area.height),
  };
}

/**
 * Placeholder used where a session is required but absent.
 *
 * ArkUI components need a non-null default for object properties, so this is the
 * shared sentinel rather than each row inventing its own.
 */
export const EMPTY_SESSION: AgentSession = {
  id: '',
  connectorId: '',
  projectId: null,
  deviceName: '',
  title: '',
  summary: '',
  cwd: null,
  workspaceLabel: '',
  runtime: '',
  runtimeLabel: '',
  status: SessionStatus.Unknown,
  statusLabel: '',
  updatedAtLabel: '',
  metaLabel: '',
  pinned: false,
  archived: false,
  unread: false,
  lastReadSeq: 0,
  takeover: false,
  connectorOnline: false,
  live: false,
  sortKey: '',
  updatedSeq: 0,
  runtimeId: '',
  runtimeType: '',
  runtimeName: '',
  archivedAt: null,
  optimisticTopUntil: 0,
  sortAt: null,
};
