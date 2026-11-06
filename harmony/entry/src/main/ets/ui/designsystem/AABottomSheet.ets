import { AAColors, AA_LIGHT_COLORS, compositeOverAlpha, withAlpha } from './AAColors';
import { AAIcon } from './AAIcon';
import { AA_ICONS } from './AAIcons';

/**
 * Bottom sheet chrome and rows.
 *
 * Port of `ui/designsystem/AABottomSheet.kt`.
 *
 * Android binds these to Material 3's `ModalBottomSheet`; ArkUI's equivalent is
 * the `bindSheet` modifier, which the screen owns. That split is why the handle
 * and header live in a component here (see `SessionRuntimeSettingsSheet`) rather
 * than in a wrapper that opens the surface itself.
 *
 * What is faithful: the 36x4 handle, the >=52dp header with a back chevron only
 * on a sub-page, the 14dp row radius with a 12dp/12dp inset, the selected row
 * container, and the trailing slot precedence (spinner, error, check, chevron,
 * spacer). What is deliberately not ported: hover, focus and pressed states,
 * which have no touch equivalent here.
 */

/** Palette the sheet is drawn with, derived from the app palette. */
export interface AABottomSheetColors {
  container: string;
  content: string;
  secondaryContent: string;
  selectedContainer: string;
  divider: string;
  handle: string;
  scrim: string;
  error: string;
  shadow: string;
}

export function aaBottomSheetColors(colors: AAColors): AABottomSheetColors {
  return {
    container: colors.raisedSurface,
    content: colors.ink,
    // Android: inkSoft @ 0.8 composited over the sheet container.
    secondaryContent: compositeOverAlpha(colors.inkSoft, 0.8, colors.raisedSurface),
    selectedContainer: colors.subtle,
    divider: withAlpha(colors.ink, 0.08),
    handle: withAlpha(colors.ink, 0.22),
    scrim: withAlpha('#000000', colors.isDark ? 0.56 : 0.28),
    error: colors.errorText,
    shadow: colors.appShadow,
  };
}

export const AA_LIGHT_SHEET_COLORS: AABottomSheetColors = aaBottomSheetColors(AA_LIGHT_COLORS);

/** The separator between the two halves of a composed supporting line. */
export const SHEET_SUFFIX_SEPARATOR: string = ' · ';

/** One sheet row: a choice, an action, a navigation row, or an error+retry. */
@Component
export struct AABottomSheetItem {
  sheetColors: AABottomSheetColors = AA_LIGHT_SHEET_COLORS;
  text: ResourceStr = '';
  /** Secondary line; `errorMessage` takes precedence when it is set. */
  supportingText: ResourceStr | null = null;
  /**
   * A second secondary segment, drawn after a `" · "` separator in the same text
   * run. Android composes such a line with `joinToString`, which ArkTS cannot do
   * without resolving a resource to a string, so the parts are laid out as spans
   * of one `Text` instead.
   */
  supportingSuffix: ResourceStr | null = null;
  errorMessage: string | null = null;
  /** Red label and icon, used for destructive rows such as Delete. */
  danger: boolean = false;
  /** Lucide path commands; empty means no leading icon. */
  icon: string = '';
  /** `null`/absent selection makes this an action row rather than a choice. */
  isChoice: boolean = false;
  isSelected: boolean = false;
  rowEnabled: boolean = true;
  isLoading: boolean = false;
  showChevron: boolean = false;
  onTap: () => void = () => {};
  @State private pressed: boolean = false;

  private contentAlpha(): number {
    return this.rowEnabled || this.isLoading ? 1 : 0.4;
  }

  private tint(): string {
    const base: string = this.danger || this.errorMessage !== null
      ? this.sheetColors.error
      : this.sheetColors.content;
    return withAlpha(base, this.contentAlpha());
  }

  private resolveBackground(): string {
    const base: string = this.isSelected ? this.sheetColors.selectedContainer : '#00000000';
    if (!this.interactive() || !this.pressed) {
      return base;
    }
    return compositeOverAlpha(this.sheetColors.content, 0.1, this.sheetColors.container);
  }

  private interactive(): boolean {
    return this.rowEnabled && !this.isLoading;
  }

  private supporting(): ResourceStr | null {
    if (this.errorMessage !== null) {
      return this.errorMessage;
    }
    return this.supportingText;
  }

  private supportingColor(): string {
    const base: string = this.errorMessage !== null
      ? this.sheetColors.error
      : this.sheetColors.secondaryContent;
    return withAlpha(base, this.contentAlpha());
  }

  build() {
    Row({ space: 12 }) {
      if (this.icon.length > 0) {
        AAIcon({ commands: this.icon, iconSize: 20, color: this.tint() })
      }

      Column({ space: 4 }) {
        Text(this.text)
          .fontSize(15)
          .lineHeight(21)
          .fontWeight(this.isSelected ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.tint())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.errorMessage === null && this.supportingSuffix !== null
          && this.supporting() !== null) {
          Text() {
            Span(this.supporting())
            Span(SHEET_SUFFIX_SEPARATOR)
            Span(this.supportingSuffix)
          }
          .fontSize(12)
          .lineHeight(17)
          .fontColor(this.supportingColor())
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        } else if (this.supporting() !== null) {
          Text(this.supporting())
            .fontSize(12)
            .lineHeight(17)
            .fontColor(this.supportingColor())
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.isLoading) {
        LoadingProgress().width(20).height(20).color(this.tint())
      } else if (this.errorMessage !== null) {
        AAIcon({ commands: AA_ICONS.CIRCLE_ALERT, iconSize: 20, color: this.tint() })
      } else if (this.isSelected) {
        AAIcon({ commands: AA_ICONS.CHECK, iconSize: 20, color: this.tint() })
      } else if (this.showChevron) {
        AAIcon({ commands: AA_ICONS.CHEVRON_RIGHT, iconSize: 20, color: this.sheetColors.secondaryContent })
      } else if (this.isChoice) {
        Column().width(20).height(20)
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 52 })
    .borderRadius(14)
    .backgroundColor(this.resolveBackground())
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressed = true;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
    .onClick(() => {
      if (this.interactive()) {
        this.onTap();
      }
    })
  }
}
