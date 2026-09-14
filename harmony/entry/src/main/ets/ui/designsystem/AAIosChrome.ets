import { AAColors, AA_LIGHT_COLORS } from './AAColors';
import { AAIcon } from './AAIcon';
import { AA_ICONS } from './AAIcons';
import { AAFontSize } from './AAMetrics';

/**
 * The iOS client's page chrome and controls, shared by every restyled screen.
 *
 * User decision (round 40): the screens follow the iOS client's layout instead of
 * Android's tall "back pill floating in the page" design — first the sign-in
 * pages, then the settings group, then the rest. The iOS counterparts are
 * `Views/Auth/AuthLayout.swift`, `Views/Components/AppGlassButton.swift` and the
 * pushed pages under `Views/Settings/`:
 *
 *  - `AAIosPage` is a navigation bar row with the dismiss/back glyph pinned to
 *    the leading edge directly under the status bar, then a large left-aligned
 *    title, then the content — subtitle first — in a scroll view inset 22dp with
 *    28dp between the content's blocks. `scrollable` is turned off by pages whose
 *    content is a full-height surface, such as the embedded web-login view.
 *  - A primary button is a 50dp capsule in `primaryControlBackground` with the
 *    inverted label; a secondary one is the same capsule in the glass material's
 *    flat equivalent — `groupedFill` with a `secondaryControlStroke` hairline.
 *  - `AAIosField` is the plain underlined text field of `UnderlinedTextField`.
 *
 * Everything the screens *do* is unchanged: the same callbacks, the same state
 * machines, the same copy from this app's own string table. iOS's own English
 * wording is deliberately not imported, so the Android and HarmonyOS clients
 * keep the same bilingual strings.
 *
 * The palette follows iOS's flat tokens where they differ from Android's theme:
 * `groupedFill` is black at 4% (white at 6% in dark) and `secondaryControlStroke`
 * is black at 14% (white at 22%).
 */

/** iOS `AppTheme.groupedFill`. */
function glassFill(colors: AAColors): string {
  return colors.isDark ? '#0FFFFFFF' : '#0A000000';
}

/**
 * iOS `AppTheme.secondaryControlStroke`.
 *
 * Also the hairline the shell draws between the split layout's two columns,
 * which on iOS is the system sidebar separator.
 */
export function iosHairline(colors: AAColors): string {
  return colors.isDark ? '#38FFFFFF' : '#24000000';
}

/** iOS `AppTheme.secondaryControlStroke`. */
function glassStroke(colors: AAColors): string {
  return iosHairline(colors);
}

/**
 * The inline navigation bar iOS uses on its sheets.
 *
 * 44dp row with the dismiss glyph on the leading edge and the title centred at
 * 17sp/600 — `.navigationBarTitleDisplayMode(.inline)` — which is what the iOS
 * client's device, files and settings surfaces carry. Trailing toolbar items go
 * in the caller's content slot; `trailingSlots` says how many there are so the
 * title stays centred between equal-width sides.
 */
@Component
export struct AAIosInlineBar {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  /** iOS's `navigationSubtitle`: a 12sp secondary line under the title. */
  subtitle: ResourceStr = '';
  onBack: () => void = () => {};
  /** How many 44dp trailing items the caller draws in the content slot. */
  trailingSlots: number = 0;
  @BuilderParam trailing: () => void = this.NoTrailing;

  build() {
    Row() {
      Column() {
        AAIcon({ commands: AA_ICONS.CHEVRON_LEFT, iconSize: 22, color: this.colors.ink })
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .accessibilityText($r('app.string.common_back'))
      .onClick(() => this.onBack())

      Column({ space: 1 }) {
        Text(this.title)
          .fontSize(17)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Center)
          .width('100%')

        if (this.subtitle !== '') {
          Text(this.subtitle)
            .fontSize(12)
            .fontColor(this.colors.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .textAlign(TextAlign.Center)
            .width('100%')
        }
      }
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)

      if (this.trailingSlots > 0) {
        Blank().width(44 * this.trailingSlots)
      }

      this.trailing()
    }
    .width('100%')
    .height(44)
    .padding({ left: 6, right: 6 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  NoTrailing() {}
}

/**
 * One page: navigation row, large title, content.
 *
 * The caller fills the content slot the way iOS passes its `@ViewBuilder`
 * closure. An empty `title` leaves the row with just the back glyph, which is
 * what the embedded web-login page uses.
 */
@Component
export struct AAIosPage {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  subtitle: ResourceStr = '';
  onBack: () => void = () => {};
  /**
   * Whether the content scrolls. The embedded web-login page turns it off: its
   * content is a full-height web view, which a scroll view would collapse.
   */
  scrollable: boolean = true;
  @BuilderParam content: () => void;

  build() {
    Column() {
      // The navigation row: iOS puts the glyph on the leading edge with no
      // surface behind it, 44pt tall so the tap target is the full bar height.
      Row() {
        Column() {
          AAIcon({ commands: AA_ICONS.CHEVRON_LEFT, iconSize: 22, color: this.colors.ink })
        }
        .width(44)
        .height(44)
        .justifyContent(FlexAlign.Center)
        .accessibilityText($r('app.string.common_back'))
        .onClick(() => this.onBack())
      }
      .width('100%')
      .height(44)
      .padding({ left: 6, right: 6 })
      .alignItems(VerticalAlign.Center)

      if (this.title !== '') {
        Text(this.title)
          .fontSize(34)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.ink)
          .lineHeight(41)
          .width('100%')
          .padding({ left: 22, right: 22 })
      }

      if (this.scrollable) {
        Scroll() {
          this.ContentColumn()
        }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Off)
      } else {
        Column() {
          this.content()
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(this.colors.canvas)
  }

  /** The content column, with iOS's 22dp inset and 28dp rhythm. */
  @Builder
  ContentColumn() {
    Column({ space: 28 }) {
      if (this.subtitle !== '') {
        Text(this.subtitle)
          .fontSize(20)
          .fontColor(this.colors.muted)
          .lineHeight(25)
          .width('100%')
      }

      this.content()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 22, right: 22, top: 22, bottom: 34 })
  }
}

/** iOS `AAIosPrimaryButton`: a prominent 50dp capsule. */
@Component
export struct AAIosPrimaryButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  iconCommands: string = '';
  loading: boolean = false;
  buttonEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 10 }) {
      if (this.loading) {
        LoadingProgress()
          .width(20)
          .height(20)
          .color(this.colors.onPrimaryAction)
      } else {
        if (this.iconCommands.length > 0) {
          AAIcon({ commands: this.iconCommands, iconSize: 18, color: this.colors.onPrimaryAction })
        }
        Text(this.label)
          .fontSize(AAFontSize.HEADER)
          .fontWeight(600)
          .fontColor(this.colors.onPrimaryAction)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('100%')
    .height(50)
    .justifyContent(FlexAlign.Center)
    .borderRadius(25)
    .backgroundColor(this.colors.primaryAction)
    .opacity(this.buttonEnabled ? 1 : 0.4)
    .onClick(() => {
      if (this.buttonEnabled && !this.loading) {
        this.onTap();
      }
    })
  }
}

/** iOS `AAIosGlassButton`: the same capsule in the glass material's flat form. */
@Component
export struct AAIosGlassButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  iconCommands: string = '';
  loading: boolean = false;
  buttonEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 10 }) {
      if (this.loading) {
        LoadingProgress()
          .width(20)
          .height(20)
          .color(this.colors.muted)
      } else {
        if (this.iconCommands.length > 0) {
          AAIcon({ commands: this.iconCommands, iconSize: 18, color: this.colors.ink })
        }
        Text(this.label)
          .fontSize(AAFontSize.HEADER)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('100%')
    .height(50)
    .justifyContent(FlexAlign.Center)
    .borderRadius(25)
    .backgroundColor(glassFill(this.colors))
    .border({ width: 1, color: glassStroke(this.colors) })
    .opacity(this.buttonEnabled ? 1 : 0.4)
    .onClick(() => {
      if (this.buttonEnabled && !this.loading) {
        this.onTap();
      }
    })
  }
}

/**
 * iOS `UnderlinedTextField`: a plain field with a divider underneath.
 *
 * The 20sp `title3` type, the 11dp vertical padding and the bottom divider are
 * the iOS metrics; there is no fill, border or radius.
 */
@Component
export struct AAIosField {
  colors: AAColors = AA_LIGHT_COLORS;
  /** Two-way, like `AuthInputRow`: the caller passes `$state`. */
  @Link fieldValue: string;
  placeholder: ResourceStr = '';
  fieldEnabled: boolean = true;
  onSubmit: () => void = () => {};

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      TextInput({ text: this.fieldValue, placeholder: this.placeholder })
        .type(InputType.Normal)
        .width('100%')
        .height(66)
        .padding({ top: 22, bottom: 22 })
        .backgroundColor('#00000000')
        .borderRadius(0)
        .fontSize(20)
        .fontColor(this.colors.ink)
        .placeholderColor(this.colors.faint)
        .enabled(this.fieldEnabled)
        .enterKeyType(EnterKeyType.Go)
        .onChange((value: string) => {
          this.fieldValue = value;
        })
        .onSubmit(() => this.onSubmit())

      Divider().color(this.colors.border)
    }
    .width('100%')
  }
}
