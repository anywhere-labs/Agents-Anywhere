import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AARadius } from '../../designsystem/AAMetrics';

/**
 * Empty-list state.
 *
 * Port of `ui/screens/common/AppEmptyState.kt`.
 *
 * The illustration is Android's own asset (`ic_sessions_empty`, 188x156dp), and
 * the spacing is the original chain: illustration, 22dp, message, 18dp, button.
 * The message is 16sp/21.5sp capped at 294dp, and the button is a 44dp pill with
 * an 8dp shadow and its icon 8dp before the label.
 */
@Component
export struct AppEmptyState {
  colors: AAColors = AA_LIGHT_COLORS;
  /**
   * A `ResourceStr` rather than a resolved string: ArkUI renders `$r(...)`
   * directly and the current localization pass is applied for us, so callers
   * never need to resolve resources by hand.
   */
  message: ResourceStr = '';
  buttonLabel: ResourceStr = '';
  buttonIconCommands: string = '';
  onButtonClick: () => void = () => {};
  /** Vertical nudge Android applies to optically centre the illustration. */
  contentOffsetY: number = 0;

  build() {
    Column({ space: 0 }) {
      Image($r('app.media.ic_sessions_empty'))
        .width(188)
        .height(156)
        .objectFit(ImageFit.Contain)

      Column().height(22)

      Text(this.message)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.colors.inkSoft)
        .lineHeight(21.5)
        .textAlign(TextAlign.Center)
        .constraintSize({ maxWidth: 294 })

      if (this.buttonLabel !== '') {
        Row({ space: 8 }) {
          if (this.buttonIconCommands.length > 0) {
            AAIcon({
              commands: this.buttonIconCommands,
              iconSize: 17,
              color: this.colors.onPrimaryAction,
            })
          }
          Text(this.buttonLabel)
            .fontSize(AAFontSize.LABEL)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.onPrimaryAction)
        }
        .height(44)
        .padding({ left: 18, right: 18 })
        .borderRadius(AARadius.PILL)
        .backgroundColor(this.colors.primaryAction)
        .shadow({ radius: 8, color: '#22000000', offsetX: 0, offsetY: 0 })
        .margin({ top: 18 })
        .onClick(() => this.onButtonClick())
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 18, right: 18, top: 28, bottom: 28 })
    .translate({ y: this.contentOffsetY })
  }
}

/**
 * Collapsible list section caption.
 *
 * Originally a port of Android's `HomeListSectionHeader`; restyled to the iOS
 * client's sidebar caption in round 40 (`ChatSidebarSectionLabel` and the
 * Projects header in `ChatSidebarProjects.swift`): 15sp semibold in the
 * secondary colour — iOS does **not** uppercase it — with a 12pt chevron that
 * rotates to -90 degrees when collapsed, plus the two 44dp icon buttons the
 * Projects section carries (the ellipsis for the session-status filter and the
 * plus for creating a project).
 *
 * `collapsible` is false for the sidebar sections iOS labels with a bare
 * `ChatSidebarSectionLabel` — the device list and the ungrouped sessions — which
 * carry neither a chevron nor a tap target.
 */
@Component
export struct AASectionHeader {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  expanded: boolean = true;
  onToggle: () => void = () => {};
  /** False for a plain caption: no chevron, no tap target. */
  collapsible: boolean = true;
  /** The status-filter button is only drawn when the caller asks for it. */
  showFilter: boolean = false;
  onFilter: () => void = () => {};
  /** Likewise for the create-project button. */
  showCreate: boolean = false;
  onCreate: () => void = () => {};

  build() {
    Row() {
      Row({ space: 6 }) {
        Text(this.label)
          .fontSize(15)
          .fontWeight(600)
          .fontColor(this.colors.muted)
          .maxLines(1)

        if (this.collapsible) {
          AAIcon({
            commands: AA_ICONS.CHEVRON_DOWN,
            iconSize: 12,
            color: this.colors.muted,
            strokeWidth: 2.4,
          })
            .rotate({ angle: this.expanded ? 0 : -90 })
        }
      }
      .layoutWeight(1)
      // iOS's caption is a text with 20/6 padding (~44dp); its Projects header is
      // a 44dp button under 16dp. Both are expressed here by the same row.
      .height(this.collapsible ? 44 : 20)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        if (this.collapsible) {
          this.onToggle();
        }
      })

      if (this.showFilter) {
        this.IconButton(
          AA_ICONS.ELLIPSIS,
          $r('app.string.home_project_filter_sessions'),
          () => this.onFilter(),
        )
      }

      if (this.showCreate) {
        this.IconButton(
          AA_ICONS.PLUS,
          $r('app.string.new_session_create_project'),
          () => this.onCreate(),
        )
      }
    }
    .width('100%')
    .padding({
      left: 10,
      right: 10,
      top: this.collapsible ? 16 : 20,
      bottom: this.collapsible ? 0 : 6,
    })
    .alignItems(VerticalAlign.Center)
  }

  /** iOS's `ChatSidebarIconControlStyle`: a 44dp square around an 18dp glyph. */
  @Builder
  IconButton(commands: string, label: Resource, action: () => void) {
    Column() {
      AAIcon({ commands: commands, iconSize: 18, color: this.colors.ink })
    }
    .width(44)
    .height(44)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(label)
    .onClick(() => action())
  }
}
