import { AgentSession } from '../../../model/AgentSession';
import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AARadius } from '../../designsystem/AAMetrics';

/**
 * Session long-press actions.
 *
 * Port of `HomeSessionActionOverlay` and `HomeRenameSessionDialog` in
 * `ui/screens/home/HomeSessionActions.kt`.
 *
 * Android dims the whole screen, redraws the pressed row as a highlight at its
 * captured bounds, and floats a 252x168dp card beside it. The same three pieces
 * are reproduced here: a scrim, a highlight box positioned from the row's
 * measured area, and the card flipped above the row when there is no room below.
 *
 * The card rows are label-left / icon-right, which is the reverse of a
 * conventional menu — that is how Android draws it.
 */

/** A row's position in the screen, captured on long-press. */
export interface AARowArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Menu card geometry, matching Android. */
const CARD_WIDTH: number = 252;
const CARD_HEIGHT: number = 168;
const CARD_GAP: number = 8;
const SCREEN_MARGIN: number = 8;

@Component
export struct SessionActionOverlay {
  colors: AAColors = AA_LIGHT_COLORS;
  session: AgentSession | null = null;
  area: AARowArea = { x: 0, y: 0, width: 0, height: 0 };
  screenWidth: number = 360;
  screenHeight: number = 800;
  onDismiss: () => void = () => {};
  onRename: () => void = () => {};
  onTogglePin: () => void = () => {};
  onToggleArchive: () => void = () => {};

  /** Places the card below the row when there is room, otherwise above it. */
  private cardTop(): number {
    const below: number = this.area.y + this.area.height + CARD_GAP;
    if (below + CARD_HEIGHT + SCREEN_MARGIN <= this.screenHeight) {
      return below;
    }
    const above: number = this.area.y - CARD_HEIGHT - CARD_GAP;
    return above < SCREEN_MARGIN ? SCREEN_MARGIN : above;
  }

  /** Keeps the card inside the screen, preferring the row's left edge. */
  private cardLeft(): number {
    const maxLeft: number = this.screenWidth - CARD_WIDTH - SCREEN_MARGIN;
    if (this.area.x > maxLeft) {
      return maxLeft > SCREEN_MARGIN ? maxLeft : SCREEN_MARGIN;
    }
    return this.area.x < SCREEN_MARGIN ? SCREEN_MARGIN : this.area.x;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      // Scrim: tapping anywhere dismisses, matching Android's dim layer.
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.colors.isDark ? '#99000000' : '#66000000')
        .onClick(() => this.onDismiss())

      // Highlight: the pressed row redrawn in place.
      Column()
        .width(this.area.width)
        .height(this.area.height)
        .offset({ x: this.area.x, y: this.area.y })
        .borderRadius(14)
        .backgroundColor(this.colors.isDark ? '#1F1F1F' : '#FFFFFF')

      Column() {
        // Order and artwork follow Android: Rename, Archive/Unarchive, Pin/Unpin,
        // each with its own `ic_session_action_*` bitmap per theme.
        this.ActionRow(this.actionIcon('rename'), $r('app.string.home_rename'),
          () => this.onRename())
        this.ActionRow(
          this.actionIcon('archive'),
          this.session !== null && this.session.archived
            ? $r('app.string.home_unarchive')
            : $r('app.string.home_archive'),
          () => this.onToggleArchive(),
        )
        this.ActionRow(
          this.actionIcon('unpin'),
          this.session !== null && this.session.pinned
            ? $r('app.string.home_unpin')
            : $r('app.string.home_pin'),
          () => this.onTogglePin(),
        )
      }
      .width(CARD_WIDTH)
      .height(CARD_HEIGHT)
      .justifyContent(FlexAlign.Center)
      .borderRadius(AARadius.BUBBLE)
      .backgroundColor(this.colors.isDark ? '#181818' : '#FFFFFF')
      .border({ width: 1, color: this.colors.border })
      .shadow({ radius: 24, color: this.colors.appShadow, offsetX: 0, offsetY: 8 })
      .offset({ x: this.cardLeft(), y: this.cardTop() })
    }
    .width('100%')
    .height('100%')
  }

  /** One of Android's `ic_session_action_*` bitmaps, in the theme's tone. */
  private actionIcon(name: string): Resource {
    if (name === 'rename') {
      return this.colors.isDark ? $r('app.media.ic_session_action_rename_white')
        : $r('app.media.ic_session_action_rename_black');
    }
    if (name === 'archive') {
      return this.colors.isDark ? $r('app.media.ic_session_action_archive_white')
        : $r('app.media.ic_session_action_archive_black');
    }
    return this.colors.isDark ? $r('app.media.ic_session_action_unpin_white')
      : $r('app.media.ic_session_action_unpin_black');
  }

  @Builder
  ActionRow(icon: Resource, label: ResourceStr, action: () => void) {
    Row() {
      Text(label)
        .fontSize(16)
        .lineHeight(20)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.isDark ? '#F4F4F5' : '#2F302D')
        .layoutWeight(1)
      Image(icon).width(22).height(22).objectFit(ImageFit.Contain)
    }
    .width('100%')
    .height(50)
    .padding({ left: 20, right: 20 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => action())
  }
}

/**
 * Rename dialog.
 *
 * Android shows a 26dp-radius card capped at 380dp with a 56dp field, and
 * disables Save while the title is unchanged or the request is in flight.
 */
@Component
export struct RenameSessionDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  initialTitle: string = '';
  busy: boolean = false;
  errorMessage: string = '';
  onCancel: () => void = () => {};
  onSave: (title: string) => void = () => {};

  @State private draft: string = '';
  /** Set when Save is attempted with a blank title, matching Android's hint. */
  @State private titleRequired: boolean = false;

  aboutToAppear(): void {
    this.draft = this.initialTitle;
  }

  private canSave(): boolean {
    const trimmed: string = this.draft.trim();
    return !this.busy && trimmed.length > 0 && trimmed !== this.initialTitle;
  }

  private attemptSave(): void {
    if (this.busy) {
      return;
    }
    const trimmed: string = this.draft.trim();
    if (trimmed.length === 0) {
      this.titleRequired = true;
      return;
    }
    if (trimmed === this.initialTitle) {
      return;
    }
    this.titleRequired = false;
    this.onSave(trimmed);
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.colors.isDark ? '#99000000' : '#66000000')
        .onClick(() => {
          if (!this.busy) {
            this.onCancel();
          }
        })

      Column({ space: 18 }) {
        Text($r('app.string.home_rename_session'))
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.ink)
          .lineHeight(29)

        Column() {
          TextInput({ text: this.draft })
            .fontSize(17)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.ink)
            .backgroundColor('#00000000')
            .borderRadius(0)
            .padding(0)
            .height('100%')
            .enterKeyType(EnterKeyType.Done)
            .onChange((next: string) => {
              this.draft = next;
              this.titleRequired = false;
            })
            .onSubmit(() => this.attemptSave())
        }
        .width('100%')
        .height(56)
        .padding({ left: 16, right: 16 })
        .borderRadius(16)
        .backgroundColor(this.colors.isDark ? '#09090B' : '#F7F7F7')
        .border({ width: 1, color: this.colors.border })

        if (this.titleRequired || this.errorMessage.length > 0) {
          Text(this.titleRequired ? $r('app.string.home_title_required') : this.errorMessage)
            .fontSize(12.5)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.errorText)
            .width('100%')
            .textAlign(TextAlign.Start)
        }

        Row({ space: 12 }) {
          this.DialogButton($r('app.string.common_cancel'), false, false, () => {
            if (!this.busy) {
              this.onCancel();
            }
          })
          this.DialogButton(
            this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
            true,
            !this.canSave(),
            () => this.attemptSave(),
          )
        }
        .width('100%')
      }
      .constraintSize({ maxWidth: 380 })
      .padding(22)
      .borderRadius(AARadius.DIALOG)
      .backgroundColor(this.colors.dialogSurface)
      .border({ width: 1, color: this.colors.border })
      .shadow({ radius: 34, color: '#33000000', offsetX: 0, offsetY: 10 })
      .margin({ left: 22, right: 22 })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  DialogButton(label: ResourceStr, primary: boolean, disabled: boolean, action: () => void) {
    Text(label)
      .fontSize(AAFontSize.BODY)
      .fontWeight(FontWeight.Bold)
      .fontColor(primary ? this.colors.onPrimaryAction : this.colors.ink)
      .textAlign(TextAlign.Center)
      .layoutWeight(1)
      .height(50)
      .borderRadius(16)
      .backgroundColor(primary ? this.colors.primaryAction : this.colors.secondaryActionSurface)
      .opacity(disabled ? 0.55 : 1)
      .enabled(!disabled)
      .onClick(() => action())
  }
}
