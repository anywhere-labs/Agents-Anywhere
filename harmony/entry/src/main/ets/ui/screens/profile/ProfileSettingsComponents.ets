import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { profileCardBackground, profileDividerColor } from './ProfileSettingsSupport';

/**
 * Row, card and header pieces of the settings screens.
 *
 * Originally a port of `ui/screens/profile/ProfileSettingsComponents.kt`; the
 * chrome was restyled to the iOS client in round 40 (`Views/Settings/SettingsComponents.swift`
 * and `AccountSettingsSheet.swift`):
 *
 *  - `ProfileHeader` is iOS's **inline** navigation bar — a 44dp row with the
 *    bare dismiss glyph on the leading edge and the title centred at 17sp/600 —
 *    instead of Android's 64dp bar with a bordered circular button.
 *  - A row is `SettingsRow`: a bare 17dp symbol (no 34dp icon box), a 17sp
 *    regular title, the value in the secondary colour and a small chevron.
 *  - `SettingsGroup` is `List(.insetGrouped)`: an optional uppercase caption
 *    above a 12dp-radius card with no border.
 *
 * Values, callbacks and the sub-page structure are unchanged.
 */

/** The drawer's navigation bar: dismiss glyph, centred title. */
@Component
export struct ProfileHeader {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  onClose: () => void = () => {};

  build() {
    Row() {
      Column() {
        AAIcon({ commands: AA_ICONS.CHEVRON_LEFT, iconSize: 22, color: this.colors.ink })
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .accessibilityText($r('app.string.common_back'))
      .onClick(() => this.onClose())

      Row() {
        Text(this.title)
          .fontSize(17)
          .lineHeight(22)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(1)
      }
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)

      Blank().width(44)
    }
    .width('100%')
    .height(44)
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * One inset-grouped section.
 *
 * iOS renders the caption small and uppercase above a borderless card; the
 * caller places the hairlines between rows, since a `@BuilderParam` slot is
 * opaque here.
 */
@Component
export struct SettingsGroup {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  @BuilderParam content: () => void;

  build() {
    Column() {
      if (this.title !== '') {
        Text(this.title)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.muted)
          .textCase(TextCase.UpperCase)
          .width('100%')
          .padding({ left: 16, bottom: 7 })
      }

      Column() {
        this.content()
      }
      .width('100%')
      .borderRadius(12)
      .backgroundColor(profileCardBackground(this.colors))
      .clip(true)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * iOS `SettingsRow`.
 *
 * `Label(title, systemImage:)` is a plain 17pt symbol before a 17pt regular
 * title — there is no icon box — and `LabeledContent` puts the value on the
 * trailing side in the secondary colour. The tag pill and the attention dot are
 * this app's extras and keep their Android geometry.
 */
@Component
export struct ProfileRow {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  title: ResourceStr = '';
  subtitle: string = '';
  trailing: string = '';
  trailingTag: string = '';
  /** Empty means no trailing icon. */
  trailingIcon: string = '';
  trailingAttention: boolean = false;
  /** Named `rowEnabled` because `enabled` collides with the component modifier. */
  rowEnabled: boolean = true;
  showChevron: boolean = true;
  /** Destructive rows paint the symbol and the title in the error colour. */
  destructive: boolean = false;
  onTap: () => void = () => {};

  build() {
    Row({ space: 12 }) {
      AAIcon({
        commands: this.commands,
        iconSize: 17,
        color: withAlpha(this.destructive ? this.colors.errorText : this.colors.ink,
          this.rowEnabled ? 1 : 0.5),
      })

      Column({ space: 1 }) {
        Text(this.title)
          .fontSize(17)
          .lineHeight(21)
          .fontColor(withAlpha(this.destructive ? this.colors.errorText : this.colors.ink,
            this.rowEnabled ? 1 : 0.5))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        if (this.subtitle.length > 0) {
          Text(this.subtitle)
            .fontSize(13)
            .lineHeight(17)
            .fontColor(withAlpha(this.colors.muted, this.rowEnabled ? 1 : 0.5))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.trailing.length > 0) {
        Text(this.trailing)
          .fontSize(15)
          .fontColor(withAlpha(this.colors.muted, this.rowEnabled ? 1 : 0.5))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      if (this.trailingTag.length > 0) {
        Text(this.trailingTag)
          .fontSize(11)
          .lineHeight(14)
          .fontWeight(600)
          .fontColor(withAlpha(this.colors.errorText, this.rowEnabled ? 1 : 0.5))
          .padding({ left: 10, right: 10, top: 4, bottom: 4 })
          .borderRadius(11)
          .backgroundColor(withAlpha(this.colors.errorSurface, this.rowEnabled ? 1 : 0.5))
          .border({
            width: 1,
            color: withAlpha(this.colors.errorBorder, this.rowEnabled ? 1 : 0.5),
          })
          .maxLines(1)
      }

      if (this.trailingIcon.length > 0) {
        Stack({ alignContent: Alignment.TopEnd }) {
          AAIcon({
            commands: this.trailingIcon,
            iconSize: 20,
            color: withAlpha(this.colors.faint, this.rowEnabled ? 1 : 0.5),
          })
          if (this.trailingAttention) {
            Column()
              .width(5)
              .height(5)
              .borderRadius(3)
              .backgroundColor(this.colors.errorText)
              // Android labels the dot, which is otherwise an unexplained mark.
              .accessibilityText($r('app.string.update_new_version_badge'))
          }
        }
      }

      if (this.showChevron) {
        AAIcon({
          commands: AA_ICONS.CHEVRON_RIGHT,
          iconSize: 14,
          color: withAlpha(this.colors.faint, this.rowEnabled ? 1 : 0.5),
        })
      }
    }
    .width('100%')
    .height(this.subtitle.length > 0 ? 56 : 48)
    .padding({ left: 16, right: 16 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/** The hairline between rows, inset to the text column as iOS does it. */
@Component
export struct ProfileDivider {
  colors: AAColors = AA_LIGHT_COLORS;
  insetStart: number = 45;
  insetEnd: number = 16;

  build() {
    Row()
      .width('100%')
      .height(1)
      .margin({ left: this.insetStart, right: this.insetEnd })
      .backgroundColor(profileDividerColor(this.colors))
  }
}

/** The destructive row at the bottom of the drawer. */
@Component
export struct SignOutCard {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  onTap: () => void = () => {};

  build() {
    ProfileRow({
      colors: this.colors,
      commands: AA_ICONS.LOG_OUT,
      title: this.label,
      destructive: true,
      showChevron: false,
      onTap: () => this.onTap(),
    })
  }
}
