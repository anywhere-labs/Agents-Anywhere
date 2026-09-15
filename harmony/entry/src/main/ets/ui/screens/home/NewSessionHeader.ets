import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { glassFill } from '../../designsystem/AAIosChrome';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { HeaderEditButton } from './NewSessionComponents';

/**
 * The new-session page's navigation bar.
 *
 * Originally a port of `ui/screens/home/NewSessionHeader.kt`; restyled in round 40
 * to the iOS client's inline bar (`ChatPageToolbar`): the dismiss glyph on the
 * leading edge, the title centred at 17sp/600 — or, in edit mode, the same field
 * over a divider — and the edit/confirm toggle as a bare trailing glyph. The
 * field re-syncs from the title whenever editing begins or the title changes
 * while not editing, which is what Android's two `LaunchedEffect`s do.
 */
@Component
export struct NewSessionHeader {
  colors: AAColors = AA_LIGHT_COLORS;
  title: string = '';
  /** Named `headerEditing` so it cannot be confused with a component attribute. */
  @Prop @Watch('onEditingChanged') headerEditing: boolean = false;
  editable: boolean = true;
  draftTitle: string = '';
  onClose: () => void = () => {};
  /**
   * Split layout: the leading glyph folds the shell's sidebar instead of closing
   * the page, which is iOS's `NewSessionView(onMenu: toggleSidebar)`.
   */
  sidebarToggle: boolean = false;
  onToggleSidebar: () => void = () => {};
  onEditToggle: () => void = () => {};
  onSubmitTitle: () => void = () => {};
  onTitleChange: (title: string) => void = () => {};

  /** The field's own copy, so typing is not fought by the incoming title. */
  @State private field: string = '';
  private static readonly FIELD_ID: string = 'aa-new-session-title';

  aboutToAppear(): void {
    this.field = this.draftTitle;
  }

  /**
   * The leading glyph's label: iOS labels the toolbar item "打开侧栏" / "Expand
   * sidebar", a back button's is the app's own "返回".
   */
  private leadingLabel(): Resource {
    return this.sidebarToggle ? $r('app.string.sidebar_toggle') : $r('app.string.common_back');
  }

  onEditingChanged(): void {
    if (this.headerEditing) {
      this.field = this.draftTitle;
      setTimeout(() => {
        this.getUIContext().getFocusController().requestFocus(NewSessionHeader.FIELD_ID);
      }, 0);
      return;
    }
    if (this.field !== this.draftTitle) {
      this.field = this.draftTitle;
    }
  }

  build() {
    Row() {
      Column() {
        AAIcon({
          commands: this.sidebarToggle ? AA_ICONS.PANEL_LEFT : AA_ICONS.CHEVRON_LEFT,
          iconSize: 22,
          color: this.colors.ink,
        })
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      // The same light disc the shared inline bar now draws: iOS's navigation-bar
      // items carry the system's glass grouping, and leaving this header bare
      // would make it the one page whose buttons differ.
      .backgroundColor(glassFill(this.colors))
      .borderRadius(22)
      .accessibilityText(this.leadingLabel())
      .onClick(() => {
        if (this.sidebarToggle) {
          this.onToggleSidebar();
        } else {
          this.onClose();
        }
      })

      if (this.headerEditing) {
        Column({ space: 1 }) {
          TextInput({ text: this.field })
            .id(NewSessionHeader.FIELD_ID)
            .width('100%')
            .height(24)
            .padding(0)
            .fontSize(17)
            .fontWeight(600)
            .fontColor(this.colors.ink)
            .textAlign(TextAlign.Center)
            .backgroundColor('#00000000')
            .caretColor(this.colors.ink)
            .enterKeyType(EnterKeyType.Done)
            .onChange((value: string) => {
              this.field = value;
              this.onTitleChange(value);
            })
            .onSubmit(() => this.onSubmitTitle())

          Divider().color(this.colors.border)
        }
        .layoutWeight(1)
        .height(44)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .padding({ left: 8, right: 8 })
      } else {
        Text(this.title)
          .fontSize(17)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .padding({ left: 8, right: 8 })
      }

      if (this.editable) {
        Column() {
          HeaderEditButton({
            colors: this.colors,
            editing: this.headerEditing,
            onTap: () => this.onEditToggle(),
          })
        }
        .width(44)
        .height(44)
        .justifyContent(FlexAlign.Center)
        .backgroundColor(glassFill(this.colors))
        .borderRadius(22)
      } else {
        Blank().width(44)
      }
    }
    .width('100%')
    .height(44)
    .padding({ left: 6, right: 6 })
    .justifyContent(FlexAlign.SpaceBetween)
    .alignItems(VerticalAlign.Center)
  }
}
