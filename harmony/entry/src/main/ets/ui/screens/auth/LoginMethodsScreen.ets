import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize } from '../../designsystem/AAMetrics';
import { AAWordmark } from '../../designsystem/AAWordmark';
import { AAIosGlassButton, AAIosPrimaryButton } from '../../designsystem/AAIosChrome';

/**
 * Sign-in method picker, the root screen while signed out.
 *
 * Port of `LoginMethodsScreen` in
 * android/app/src/main/java/com/agentsanywhere/app/ui/screens/auth/AuthScreens.kt,
 * restyled in round 40 to the iOS client's entry layout
 * (`Views/Auth/ServiceEntryView.swift` with `AuthWelcomeLayout`): the brand
 * lockup centred in the page with 28dp of rhythm, then the two capsules — the
 * method that is expected first is the prominent one.
 *
 * The available methods, their order, their actions and the copy are unchanged.
 */
@Component
export struct LoginMethodsScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  onOpenQrLogin: () => void = () => {};
  onOpenServerSetup: () => void = () => {};

  build() {
    Column({ space: 28 }) {
      // The brand lockup: iOS centres it in the free space above the buttons.
      Blank()

      Column({ space: 18 }) {
        AAWordmark({ colors: this.colors, fontSize: AAFontSize.WORDMARK, lineHeight: 44 })
        Text($r('app.string.auth_choose_login'))
          .fontSize(20)
          .fontColor(this.colors.muted)
          .lineHeight(25)
          .textAlign(TextAlign.Center)
      }
      .alignItems(HorizontalAlign.Center)
      .width('100%')

      Column({ space: 12 }) {
        AAIosPrimaryButton({
          colors: this.colors,
          label: $r('app.string.auth_continue_qr'),
          iconCommands: AA_ICONS.QR_CODE,
          onTap: this.onOpenQrLogin,
        })
        AAIosGlassButton({
          colors: this.colors,
          label: $r('app.string.auth_password_login'),
          iconCommands: AA_ICONS.USER_KEY,
          onTap: this.onOpenServerSetup,
        })
      }
      .width('100%')
      .constraintSize({ maxWidth: 340 })

      Blank()
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Center)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 28, right: 28, top: 24, bottom: 24 })
    .backgroundColor(this.colors.canvas)
  }
}
