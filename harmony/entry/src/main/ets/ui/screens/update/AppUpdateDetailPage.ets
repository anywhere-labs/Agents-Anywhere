import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAFontSize } from '../../designsystem/AAMetrics';
import { AAIosGlassButton, AAIosPrimaryButton } from '../../designsystem/AAIosChrome';
import { AndroidAppRelease } from '../../../api/AppUpdatesApi';
import { AppUpdateState } from '../../../feature/update/AppUpdateController';
import { SettingsGroup } from '../profile/ProfileSettingsComponents';

/**
 * The Updates page inside the settings drawer.
 *
 * Port of `ProfileSettingsDetails.kt`'s `UpdateDetailPage`, restyled in round 40
 * to the iOS list language: the release offer is an inset-grouped section with the
 * message inside it and the iOS prominent capsule as its action, and the empty
 * state is a centred secondary line over an iOS glass capsule. Copy, states and
 * callbacks are unchanged.
 */
@Component
export struct AppUpdateDetailPage {
  colors: AAColors = AA_LIGHT_COLORS;
  state: AppUpdateState = AppUpdateState.empty();
  onUpdate: () => void = () => {};
  onCheckAgain: () => void = () => {};

  build() {
    if (this.state.release !== null) {
      Column({ space: 28 }) {
        SettingsGroup({ colors: this.colors }) {
          Column({ space: 10 }) {
            Text($r('app.string.update_available_title'))
              .fontSize(17)
              .lineHeight(21)
              .fontWeight(600)
              .fontColor(this.colors.ink)
              .width('100%')

            Text($r('app.string.update_available_message',
              (this.state.release as AndroidAppRelease).versionName))
              .fontSize(15)
              .lineHeight(20)
              .fontColor(this.colors.muted)
              .width('100%')

            if (this.state.downloadUnavailable) {
              Text($r('app.string.update_download_unavailable'))
                .fontSize(13)
                .lineHeight(18)
                .fontColor(this.colors.errorText)
                .width('100%')
            }
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .alignItems(HorizontalAlign.Start)
        }

        AAIosPrimaryButton({
          colors: this.colors,
          label: $r('app.string.update_now'),
          onTap: () => this.onUpdate(),
        })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    } else {
      Column({ space: 16 }) {
        if (this.state.checking) {
          LoadingProgress()
            .width(24)
            .height(24)
            .color(this.colors.muted)
        } else {
          Text(this.state.checkFailed
            ? $r('app.string.update_check_failed')
            : $r('app.string.update_up_to_date'))
            .fontSize(AAFontSize.HEADER)
            .lineHeight(22)
            .fontColor(this.colors.muted)
            .maxLines(2)
            .textAlign(TextAlign.Center)

          AAIosGlassButton({
            colors: this.colors,
            label: $r('app.string.update_retry'),
            onTap: () => this.onCheckAgain(),
          })
        }
      }
      .width('100%')
      .height(260)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
    }
  }
}
