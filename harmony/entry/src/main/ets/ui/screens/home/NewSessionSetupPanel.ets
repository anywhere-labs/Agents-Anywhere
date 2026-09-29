import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { NewSessionSetupReason, NewSessionSetupState } from './NewSessionSetupState';
import { StartChatButton } from './NewSessionComponents';

/**
 * The explanation shown while the page cannot offer any control.
 *
 * Port of `ui/screens/home/NewSessionSetupPanel.kt`.
 *
 * The device and agent checks render nothing at all — they are expected to
 * finish in a moment — while a failure offers a retry and every other reason
 * points the user at the device list. The illustration is Android's
 * `ic_agent_unavailable` bitmap at 168dp, and the action is the same 54dp
 * primary button, capped at 224dp inside a 360dp column.
 */
@Component
export struct NewSessionSetupPanel {
  colors: AAColors = AA_LIGHT_COLORS;
  state: NewSessionSetupState = new NewSessionSetupState(NewSessionSetupReason.CheckingDevices);
  refreshing: boolean = false;
  onOpenDevices: () => void = () => {};
  onRetry: () => void = () => {};

  private isRetry(): boolean {
    return this.state.reason === NewSessionSetupReason.AgentLoadFailed
      || this.state.reason === NewSessionSetupReason.DeviceLoadFailed;
  }

  /** The two "still checking" reasons render nothing. */
  private visible(): boolean {
    return this.state.reason !== NewSessionSetupReason.CheckingDevices
      && this.state.reason !== NewSessionSetupReason.CheckingAgents;
  }

  private message(): ResourceStr {
    switch (this.state.reason) {
      case NewSessionSetupReason.AgentLoadFailed:
        return $r('app.string.new_session_agents_unavailable_description');
      case NewSessionSetupReason.DeviceLoadFailed:
        return $r('app.string.new_session_devices_unavailable_description');
      default:
        return $r('app.string.new_session_no_available_agents');
    }
  }

  build() {
    if (this.visible()) {
      Column() {
        Column() {
          Image($r('app.media.ic_agent_unavailable'))
            .width(168)
            .height(168)
            .objectFit(ImageFit.Contain)

          Blank().height(24)

          Text(this.message())
            .fontSize(16)
            .lineHeight(25)
            .fontColor(this.colors.inkSoft)
            .textAlign(TextAlign.Center)

          Blank().height(28)

          Column() {
            StartChatButton({
              colors: this.colors,
              label: this.isRetry() ? $r('app.string.common_retry')
                : $r('app.string.new_session_configure_agent_action'),
              buttonEnabled: !this.isRetry() || !this.refreshing,
              onTap: () => {
                if (this.isRetry()) {
                  this.onRetry();
                } else {
                  this.onOpenDevices();
                }
              },
            })
          }
          .constraintSize({ maxWidth: 224 })
          .width('100%')
        }
        .constraintSize({ maxWidth: 360 })
        .width('100%')
        .padding({ left: 28, right: 28, top: 32, bottom: 32 })
        .alignItems(HorizontalAlign.Center)
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
    }
  }
}
