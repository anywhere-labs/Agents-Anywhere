import { AgentProject } from '../../../model/AgentSession';
import { ProjectSessionStatusFilter } from '../../../feature/sessions/ProjectSessionsState';
import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AARadius } from '../../designsystem/AAMetrics';
import { AARowArea } from './HomeSessionActions';

/**
 * Project long-press actions, the edit sheet and the archive confirmation.
 *
 * Port of `HomeProjectActionOverlay`, `HomeProjectEditSheet`,
 * `HomeArchiveProjectDialog` and `HomeProjectFilterMenu` in
 * `ui/screens/home/HomeProjectComponents.kt` / `HomeProjectMenus.kt`.
 *
 * The action card matches the session one: a 252x168dp panel with three 50dp
 * rows laid out label-left / icon-right, floating beside the pressed row.
 */

const CARD_WIDTH: number = 252;
const CARD_HEIGHT: number = 168;
const CARD_GAP: number = 8;
const SCREEN_MARGIN: number = 8;

@Component
export struct ProjectActionOverlay {
  colors: AAColors = AA_LIGHT_COLORS;
  project: AgentProject | null = null;
  area: AARowArea = { x: 0, y: 0, width: 0, height: 0 };
  screenWidth: number = 360;
  screenHeight: number = 800;
  onDismiss: () => void = () => {};
  onEdit: () => void = () => {};
  onTogglePin: () => void = () => {};
  onArchive: () => void = () => {};

  private cardTop(): number {
    const below: number = this.area.y + this.area.height + CARD_GAP;
    if (below + CARD_HEIGHT + SCREEN_MARGIN <= this.screenHeight) {
      return below;
    }
    const above: number = this.area.y - CARD_HEIGHT - CARD_GAP;
    return above < SCREEN_MARGIN ? SCREEN_MARGIN : above;
  }

  private cardLeft(): number {
    const maxLeft: number = this.screenWidth - CARD_WIDTH - SCREEN_MARGIN;
    if (this.area.x > maxLeft) {
      return maxLeft > SCREEN_MARGIN ? maxLeft : SCREEN_MARGIN;
    }
    return this.area.x < SCREEN_MARGIN ? SCREEN_MARGIN : this.area.x;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.colors.isDark ? '#99000000' : '#66000000')
        .onClick(() => this.onDismiss())

      Column()
        .width(this.area.width)
        .height(this.area.height)
        .offset({ x: this.area.x, y: this.area.y })
        .borderRadius(14)
        .backgroundColor(this.colors.isDark ? '#1F1F1F' : '#FFFFFF')

      Column() {
        this.ActionRow(AA_ICONS.PENCIL, $r('app.string.home_project_edit'), false, () => this.onEdit())
        this.ActionRow(
          AA_ICONS.PIN,
          this.project !== null && this.project.pinned
            ? $r('app.string.home_project_unpin')
            : $r('app.string.home_project_pin'),
          false,
          () => this.onTogglePin(),
        )
        this.ActionRow(
          AA_ICONS.ARCHIVE,
          $r('app.string.home_project_archive'),
          true,
          () => this.onArchive(),
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

  @Builder
  ActionRow(iconCommands: string, label: ResourceStr, danger: boolean, action: () => void) {
    Row() {
      Text(label)
        .fontSize(AAFontSize.BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor(danger ? '#F87171' : this.colors.ink)
        .layoutWeight(1)
      AAIcon({
        commands: iconCommands,
        iconSize: 19,
        color: danger ? '#F87171' : this.colors.inkSoft,
      })
    }
    .width('100%')
    .height(50)
    .padding({ left: 18, right: 18 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => action())
  }
}

/**
 * Project edit sheet.
 *
 * Android shows a bottom sheet titled "Edit project" with an editable name and
 * read-only Device and Path fields, because the Server cannot move a project
 * once its sessions exist.
 */
@Component
export struct ProjectEditSheet {
  colors: AAColors = AA_LIGHT_COLORS;
  project: AgentProject | null = null;
  deviceName: string = '';
  busy: boolean = false;
  errorMessage: string = '';
  onCancel: () => void = () => {};
  onSave: (name: string) => void = () => {};

  @State private draft: string = '';
  @State private nameRequired: boolean = false;

  aboutToAppear(): void {
    if (this.project !== null) {
      this.draft = this.project.name;
    }
  }

  private canSave(): boolean {
    const trimmed: string = this.draft.trim();
    if (this.busy || trimmed.length === 0 || this.project === null) {
      return false;
    }
    return trimmed !== this.project.name;
  }

  private attemptSave(): void {
    if (this.busy) {
      return;
    }
    const trimmed: string = this.draft.trim();
    if (trimmed.length === 0) {
      this.nameRequired = true;
      return;
    }
    if (this.project !== null && trimmed === this.project.name) {
      return;
    }
    this.nameRequired = false;
    this.onSave(trimmed);
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
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
        Text($r('app.string.home_project_edit_title'))
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.ink)

        Column({ space: 8 }) {
          Text($r('app.string.home_project_name'))
            .fontSize(AAFontSize.CAPTION)
            .fontColor(this.colors.muted)
            .alignSelf(ItemAlign.Start)
          Column() {
            TextInput({ text: this.draft })
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.colors.ink)
              .backgroundColor('#00000000')
              .borderRadius(0)
              .padding(0)
              .height('100%')
              .enterKeyType(EnterKeyType.Done)
              .onChange((next: string) => {
                this.draft = next;
                this.nameRequired = false;
              })
              .onSubmit(() => this.attemptSave())
          }
          .width('100%')
          .height(50)
          .padding({ left: 14, right: 14 })
          .borderRadius(14)
          .backgroundColor(this.colors.subtle)
          .border({ width: 1, color: this.colors.border })
        }
        .width('100%')

        this.ReadOnlyField($r('app.string.home_project_device'), this.deviceName)
        this.ReadOnlyField(
          $r('app.string.home_project_path'),
          this.project !== null ? this.project.workspacePath : '',
        )

        Text($r('app.string.home_project_path_immutable'))
          .fontSize(12.5)
          .fontColor(this.colors.muted)
          .width('100%')

        if (this.nameRequired || this.errorMessage.length > 0) {
          Text(this.nameRequired ? $r('app.string.home_title_required') : this.errorMessage)
            .fontSize(12.5)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.errorText)
            .width('100%')
        }

        Row({ space: 12 }) {
          this.SheetButton($r('app.string.common_cancel'), false, false, () => {
            if (!this.busy) {
              this.onCancel();
            }
          })
          this.SheetButton(
            this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
            true,
            !this.canSave(),
            () => this.attemptSave(),
          )
        }
        .width('100%')
      }
      .width('100%')
      .padding({ left: 22, right: 22, top: 22, bottom: 28 })
      .borderRadius({ topLeft: AARadius.SHEET, topRight: AARadius.SHEET })
      .backgroundColor(this.colors.raisedSurface)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  ReadOnlyField(label: ResourceStr, value: string) {
    Column({ space: 8 }) {
      Text(label)
        .fontSize(AAFontSize.CAPTION)
        .fontColor(this.colors.muted)
        .alignSelf(ItemAlign.Start)
      Text(value)
        .fontSize(AAFontSize.BODY)
        .fontColor(this.colors.ink)
        .width('100%')
        .padding({ left: 14, right: 14, top: 14, bottom: 14 })
        .borderRadius(14)
        .backgroundColor(this.colors.matchedAccountSurface)
    }
    .width('100%')
  }

  @Builder
  SheetButton(label: ResourceStr, primary: boolean, disabled: boolean, action: () => void) {
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

/** Confirmation shown before archiving every active session in a project. */
@Component
export struct ProjectArchiveDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  project: AgentProject | null = null;
  busy: boolean = false;
  onCancel: () => void = () => {};
  onConfirm: () => void = () => {};

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
        Text($r('app.string.home_project_archive_title'))
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.ink)
          .lineHeight(28)
        Text($r('app.string.home_project_archive_description',
          this.project !== null ? this.project.name : ''))
          .fontSize(AAFontSize.LABEL)
          .fontColor(this.colors.muted)
          .lineHeight(20)
        Row({ space: 12 }) {
          Text($r('app.string.common_cancel'))
            .fontSize(AAFontSize.BODY)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.ink)
            .textAlign(TextAlign.Center)
            .layoutWeight(1)
            .height(50)
            .borderRadius(16)
            .backgroundColor(this.colors.secondaryActionSurface)
            .opacity(this.busy ? 0.55 : 1)
            .enabled(!this.busy)
            .onClick(() => this.onCancel())
          Text($r('app.string.home_project_archive'))
            .fontSize(AAFontSize.BODY)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.onPrimaryAction)
            .textAlign(TextAlign.Center)
            .layoutWeight(1)
            .height(50)
            .borderRadius(16)
            .backgroundColor(this.colors.primaryAction)
            .opacity(this.busy ? 0.55 : 1)
            .enabled(!this.busy)
            .onClick(() => this.onConfirm())
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
}

/**
 * Project session-status filter.
 *
 * Android presents it as an anchored dropdown labelled "Session status" with
 * three radio rows. It is rendered inline here so it does not need an anchor
 * measurement, with the same label and option copy.
 */
@Component
export struct ProjectFilterMenu {
  colors: AAColors = AA_LIGHT_COLORS;
  filter: ProjectSessionStatusFilter = ProjectSessionStatusFilter.Active;
  onSelect: (filter: ProjectSessionStatusFilter) => void = () => {};
  onDismiss: () => void = () => {};

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#00000000')
        .onClick(() => this.onDismiss())

      Column() {
        Text($r('app.string.home_project_session_status'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.muted)
          .padding({ left: 14, top: 10, bottom: 6 })
          .alignSelf(ItemAlign.Start)

        this.FilterRow($r('app.string.home_project_filter_active'), ProjectSessionStatusFilter.Active)
        this.FilterRow($r('app.string.home_project_filter_archived'), ProjectSessionStatusFilter.Archived)
        this.FilterRow($r('app.string.home_project_filter_all'), ProjectSessionStatusFilter.All)
      }
      .width(286)
      .padding({ top: 6, bottom: 8 })
      .margin({ top: 44, right: 4 })
      .borderRadius(AARadius.CARD)
      .backgroundColor(this.colors.isDark ? this.colors.subtle : this.colors.raisedSurface)
      .border({ width: 1, color: this.colors.border })
      .shadow({ radius: 18, color: this.colors.appShadow, offsetX: 0, offsetY: 6 })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  FilterRow(label: ResourceStr, value: ProjectSessionStatusFilter) {
    Row({ space: 10 }) {
      AAIcon({
        commands: this.filter === value ? AA_ICONS.CIRCLE_CHECK : AA_ICONS.CIRCLE,
        iconSize: 18,
        color: this.filter === value ? this.colors.sessionStatusAccent : this.colors.faint,
      })
      Text(label)
        .fontSize(AAFontSize.LABEL)
        .fontWeight(this.filter === value ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(this.colors.ink)
        .layoutWeight(1)
    }
    .width('100%')
    .height(48)
    .padding({ left: 14, right: 14 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onSelect(value))
  }
}
