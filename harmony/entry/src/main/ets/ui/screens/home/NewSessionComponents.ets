import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_GLYPHS, AA_ICONS } from '../../designsystem/AAIcons';
import { resolveString } from '../../../common/AAResources';

/**
 * Shared pieces of the new-session page.
 *
 * Port of `ui/screens/home/NewSessionCommonComponents.kt`,
 * `NewSessionWorkspaceSection.kt`'s row components, `NewSessionPathSection.kt`'s
 * row and message, and `WorkspaceMarqueeText.kt`.
 *
 * Every metric comes from Android unchanged: the 30dp pills, the 36dp mini
 * buttons, the 54dp start button, the 16dp workspace rows and the 58dp path
 * rows.
 *
 * Android's `SmallPill` and `CircleMiniButton` are generic containers that take
 * a composable slot. ArkUI has no equivalent for a plain component, so each
 * *use* of those containers is a concrete component here (a back pill, a parent
 * button, a confirm button, an expand toggle), which keeps the same geometry
 * with no slot plumbing.
 */

/** Android's `SmallPill` carrying the path section's "Back" label. */
@Component
export struct BackSmallPill {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  /** Named `pillEnabled` because `enabled` collides with the component modifier. */
  pillEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 5 }) {
      AAIcon({
        commands: AA_GLYPHS.BACK,
        iconSize: 22,
        strokeWidth: AA_GLYPHS.BACK_STROKE,
        color: this.colors.isDark ? '#A1A1AA' : '#555555',
      })
      Text(this.label)
        .fontSize(13)
        .fontWeight(800)
        .fontColor(this.colors.isDark ? '#A1A1AA' : '#555555')
        .maxLines(1)
    }
    .height(30)
    .padding({ left: 10, right: 10 })
    .borderRadius(15)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : '#FBFBFB')
    .border({
      width: 1,
      color: this.colors.isDark ? '#27272A' : '#ECECEC',
    })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.pillEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * Android's `CircleMiniButton`: a 36dp circular outline button around one icon.
 *
 * `dimToDisabled` carries the confirm button's rule: its check mark is drawn in
 * a dimmer colour, not at a lower opacity, while the button is unusable.
 */
@Component
export struct MiniCircleButton {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  iconSize: number = 22;
  strokeWidth: number = 2;
  iconColor: string = '#000000';
  dimIconColor: string = '#BDBDBD';
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  /**
   * Android's `contentDescription`, resolved by the caller.
   *
   * A `string` rather than a `Resource`: `accessibilityText` has separate
   * overloads for the two and rejects the union, and this button is used both with
   * a description (the confirm check) and without one (the parent arrow).
   */
  description: string = '';
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({
        commands: this.commands,
        iconSize: this.iconSize,
        strokeWidth: this.strokeWidth,
        color: this.buttonEnabled ? this.iconColor : this.dimIconColor,
      })
    }
    .width(36)
    .height(36)
    .borderRadius(18)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : '#FFFFFF')
    .border({
      width: 1,
      color: this.colors.isDark ? '#27272A' : '#E8E8E8',
    })
    .justifyContent(FlexAlign.Center)
    .accessibilityText(this.description)
    .onClick(() => {
      if (this.buttonEnabled) {
        this.onTap();
      }
    })
  }
}

/** Android's `HeaderCircleButton`: the 40dp edit/confirm toggle. */
@Component
export struct HeaderEditButton {
  colors: AAColors = AA_LIGHT_COLORS;
  editing: boolean = false;
  onTap: () => void = () => {};

  build() {
    Column() {
      if (this.editing) {
        AAIcon({ commands: AA_ICONS.CHECK, iconSize: 22, color: this.colors.ink })
      } else {
        AAIcon({
          commands: AA_ICONS.PENCIL,
          iconSize: 18,
          color: this.colors.isDark ? '#A1A1AA' : '#555555',
        })
      }
    }
    .width(40)
    .height(40)
    .borderRadius(20)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : '#FFFFFF')
    .border({
      width: 1,
      color: this.colors.isDark ? '#27272A' : '#E8E8E8',
    })
    .justifyContent(FlexAlign.Center)
    // Android's `HeaderCircleButton` labels the confirm state "done" and leaves
    // the pencil unlabelled; an empty string is the same "no description".
    .accessibilityText(this.editing ? resolveString($r('app.string.common_done')) : '')
    .onClick(() => this.onTap())
  }
}

/** The path browser's expand/collapse affordance: 36dp, 12dp radius. */
@Component
export struct ListToggleButton {
  colors: AAColors = AA_LIGHT_COLORS;
  expanded: boolean = true;
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({
        commands: this.expanded ? AA_ICONS.CHEVRON_DOWN : AA_ICONS.CHEVRON_RIGHT,
        iconSize: 20,
        color: this.colors.inkSoft,
      })
    }
    .width(36)
    .height(36)
    .borderRadius(12)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(this.expanded
      ? $r('app.string.new_session_collapse_directory')
      : $r('app.string.new_session_expand_directory'))
    .onClick(() => {
      if (this.buttonEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * The primary "start chat" button.
 *
 * 54dp tall, an 18dp radius, the label at 16sp/20sp semi-bold, and a forward
 * glyph after an 8dp gap. Disabling it keeps the colour and drops the opacity to
 * 45%, exactly as Android does.
 */
@Component
export struct StartChatButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 8 }) {
      Text(this.label)
        .fontSize(16)
        .lineHeight(20)
        .fontWeight(600)
        .fontColor(this.colors.onPrimaryAction)

      AAIcon({
        commands: AA_GLYPHS.FORWARD,
        iconSize: 22,
        strokeWidth: AA_GLYPHS.FORWARD_STROKE,
        color: this.colors.onPrimaryAction,
      })
    }
    .width('100%')
    .height(54)
    .borderRadius(18)
    .backgroundColor(withAlpha(this.colors.primaryAction, this.buttonEnabled ? 1 : 0.45))
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.buttonEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * A path that marquees only while its row is selected.
 *
 * Port of `WorkspaceMarqueeText.kt`: an ellipsized single line normally, and
 * otherwise — after a 350 ms pause — one linear pass that stops at the end,
 * travelling at 30 ms for every logical pixel of overflow. The overflow is the
 * laid-out text width minus the viewport width, both measured from the layout.
 */
@Component
export struct WorkspaceMarqueeText {
  text: string = '';
  /**
   * `@Prop` for the same reason as `WorkspaceOptionRow.selected`: only the
   * selected row marquees, so a plain member meant a newly selected long path
   * kept its ellipsis and never started the pass.
   */
  @Prop selected: boolean = false;
  fontSize: number = 12;
  fontColor: string = '#000000';
  /** iOS renders these path lines in `.footnote` monospace. */
  monospace: boolean = false;

  @State private offsetX: number = 0;
  @State private textWidth: number = 0;
  @State private viewportWidth: number = 0;
  private scrollTimer: number = -1;

  aboutToDisappear(): void {
    this.cancelScroll();
  }

  private cancelScroll(): void {
    if (this.scrollTimer >= 0) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = -1;
    }
  }

  private overflowDistance(): number {
    return Math.max(this.textWidth - this.viewportWidth, 0);
  }

  private scrolling(): boolean {
    return this.selected && this.overflowDistance() > 0;
  }

  /** Android converts the pixel overflow to dp and spends 30 ms on each dp. */
  private scheduleScroll(): void {
    this.cancelScroll();
    this.offsetX = 0;
    if (!this.scrolling()) {
      return;
    }
    const distance: number = this.overflowDistance();
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = -1;
      const density: number = this.getUIContext().vp2px(1);
      const duration: number = Math.max(Math.round(distance / density * 30), 1);
      this.getUIContext().animateTo({
        duration: duration,
        curve: Curve.Linear,
      }, () => {
        this.offsetX = distance;
      });
    }, 350);
  }

  build() {
    Row() {
      Text(this.text)
        .fontSize(this.fontSize)
        .fontFamily(this.monospace ? 'monospace' : '')
        .fontColor(this.fontColor)
        .maxLines(1)
        .textOverflow({
          overflow: this.scrolling() ? TextOverflow.Clip : TextOverflow.Ellipsis,
        })
        .width(this.scrolling() ? 'auto' : '100%')
        .translate({ x: -this.offsetX })
        .onAreaChange((_oldArea: Area, newArea: Area) => {
          const width: number = Number(newArea.width);
          if (width !== this.textWidth) {
            this.textWidth = width;
            this.scheduleScroll();
          }
        })
    }
    .width('100%')
    .clip(true)
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      const width: number = Number(newArea.width);
      if (width !== this.viewportWidth) {
        this.viewportWidth = width;
        this.scheduleScroll();
      }
    })
  }
}

/** One workspace choice: a folder, a title, the path and a selected mark. */
@Component
export struct WorkspaceOptionRow {
  colors: AAColors = AA_LIGHT_COLORS;
  title: string = '';
  path: string = '';
  /**
   * Whether this row carries the checkmark.
   *
   * `@Prop`, not a plain member: the row lives in the section's `ForEach`, and
   * `selected` is recomputed from the page's chosen path on every re-render. A
   * plain member is only applied when the row is *created*, so tapping a row
   * selected it in the page's state while the checkmark stayed where it was.
   * The page -> section boundary is `NewSessionWorkspaceSection.path` (`@Prop`);
   * this is the second, section -> row boundary, and it was the one still open.
   */
  @Prop selected: boolean = false;
  /** Named `rowEnabled` because `enabled` collides with the component modifier. */
  rowEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    // iOS's selection rows (`ProjectSelectionSheet`): the row carries no surface
    // of its own, the section card does; the choice is marked by a checkmark.
    Row({ space: 14 }) {
      AAIcon({ commands: AA_ICONS.FOLDER, iconSize: 20, color: this.colors.ink })

      Column({ space: 2 }) {
        Text(this.title)
          .fontSize(17)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        WorkspaceMarqueeText({
          text: this.path,
          selected: this.selected,
          fontSize: 12,
          fontColor: this.colors.muted,
          monospace: true,
        })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.selected) {
        AAIcon({ commands: AA_ICONS.CHECK, iconSize: 17, color: this.colors.ink })
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * An action row above the choices ("Browse filesystem", "New project").
 *
 * iOS renders these as `Label(title, symbol)` buttons — no chevron and no surface
 * of their own; the row fades to 45% when it is not usable.
 */
@Component
export struct WorkspaceActionRow {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  commands: string = '';
  /** Named `rowEnabled` because `enabled` collides with the component modifier. */
  rowEnabled: boolean = true;
  raised: boolean = false;
  onTap: () => void = () => {};

  build() {
    // iOS's action rows are `Label(title, systemImage:)` buttons: symbol, title,
    // no chevron and no surface of their own unless the caller asks for a card.
    Row({ space: 14 }) {
      AAIcon({
        commands: this.commands,
        iconSize: 20,
        color: withAlpha(this.colors.ink, this.rowEnabled ? 1 : 0.45),
      })
      Text(this.title)
        .fontSize(17)
        .fontColor(withAlpha(this.colors.ink, this.rowEnabled ? 1 : 0.45))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .margin({ top: this.raised ? 6 : 0, bottom: this.raised ? 6 : 0 })
    .borderRadius(12)
    .backgroundColor(this.raised ? this.colors.raisedSurface : '#00000000')
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/** One directory row in the path browser: iOS's row with a folder and a chevron. */
@Component
export struct PathRow {
  colors: AAColors = AA_LIGHT_COLORS;
  name: string = '';
  /** Named `rowEnabled` because `enabled` collides with the component modifier. */
  rowEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 14 }) {
      AAIcon({
        commands: AA_ICONS.FOLDER,
        iconSize: 20,
        color: this.colors.ink,
      })
      Text(this.name)
        .fontSize(17)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      AAIcon({
        commands: AA_ICONS.CHEVRON_RIGHT,
        iconSize: 14,
        color: this.colors.muted,
      })
    }
    .width('100%')
    .height(44)
    .padding({ left: 16, right: 16 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/** A quiet message inside the path list. */
@Component
export struct PathMessage {
  colors: AAColors = AA_LIGHT_COLORS;
  message: ResourceStr = '';

  build() {
    Text(this.message)
      .fontSize(14)
      .fontWeight(600)
      .fontColor(this.colors.isDark ? '#A1A1AA' : '#777777')
      .padding({ left: 4, top: 18 })
  }
}

/** The retry affordance Android adds under a path error. */
@Component
export struct PathRetryAction {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  /** Named `rowEnabled` because `enabled` collides with the component modifier. */
  rowEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Text(this.label)
      .fontSize(14)
      .fontWeight(600)
      .fontColor(this.colors.inkSoft)
      .padding({ top: 12, bottom: 12 })
      .onClick(() => {
        if (this.rowEnabled) {
          this.onTap();
        }
      })
  }
}
