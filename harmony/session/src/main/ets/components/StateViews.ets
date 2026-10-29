import { APP_IS_DARK_KEY, getColors } from 'common';

/**
 * Reusable empty/placeholder state view.
 *
 * Shows a large glyph (emoji or icon) plus a message, with an optional primary
 * action button. Used for "no data", "no results", or "sign in to continue"
 * surfaces so pages do not re-implement the same layout.
 */
@Component
export struct EmptyState {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  glyph: ResourceStr = '\u{1F4DD}';
  message: ResourceStr = '';
  actionLabel?: ResourceStr;
  actionSymbol: Resource = $r('sys.symbol.plus');
  onAction?: () => void;

  build() {
    Column() {
      Text(this.glyph)
        .fontSize(40)
        .fontColor(getColors().faint)
      Text(this.message)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .lineHeight(21.5)
        .fontColor(getColors().inkSoft)
        .textAlign(TextAlign.Center)
        .maxLines(3)
        .constraintSize({ maxWidth: 294 })
      if (this.actionLabel !== undefined && this.actionLabel !== '' && this.onAction !== undefined) {
        Row({ space: 8 }) {
          SymbolGlyph(this.actionSymbol)
            .fontSize(17)
            .fontColor([getColors().onPrimaryAction])
          Text(this.actionLabel)
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor(getColors().onPrimaryAction)
        }
        .height(44)
        .padding({ left: 18, right: 18 })
        .borderRadius(22)
        .backgroundColor(getColors().primaryAction)
        .margin({ top: 18 })
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          this.onAction!();
        })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }
}

/**
 * Reusable loading state view.
 *
 * Shows a centered spinner plus an optional message. Use it while a page or a
 * section is fetching data instead of ad-hoc `LoadingProgress` placements.
 */
@Component
export struct LoadingState {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  message?: ResourceStr;

  build() {
    Column({ space: 12 }) {
      LoadingProgress()
        .width(36)
        .height(36)
        .color(getColors().primaryAction)
      if (this.message !== undefined) {
        Text(this.message)
          .fontSize(14)
          .fontColor(getColors().muted)
          .textAlign(TextAlign.Center)
          .width('80%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }
}

/**
 * Reusable error state view.
 *
 * Shows an error message plus an optional retry button. `onRetry` defaults to a
 * no-op so callers that only need to surface an error do not have to provide it.
 */
@Component
export struct ErrorState {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  glyph: ResourceStr = '\u{26A0}\u{FE0F}';
  message: ResourceStr = '';
  retryLabel: ResourceStr = $r('app.string.login_retry');
  onRetry: () => void = () => {};

  build() {
    Column({ space: 12 }) {
      Text(this.glyph)
        .fontSize(36)
        .fontColor(getColors().errorText)
      Text(this.message)
        .fontSize(14)
        .fontColor(getColors().inkSoft)
        .textAlign(TextAlign.Center)
        .maxLines(4)
        .width('80%')
      Button(this.retryLabel)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().onPrimaryAction)
        .backgroundColor(getColors().primaryAction)
        .margin({ top: 6 })
        .height(40)
        .padding({ left: 18, right: 18 })
        .onClick(() => {
          this.onRetry();
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }
}
