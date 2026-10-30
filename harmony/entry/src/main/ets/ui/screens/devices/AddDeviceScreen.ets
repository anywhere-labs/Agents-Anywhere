import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { AAIosInlineBar } from '../../designsystem/AAIosChrome';
import { DeviceConfirmDialog } from './DeviceConfirmDialog';
import {
  PairingActionButton, PairingBodyText, PairingChoiceCard, PairingCodeBlock, PairingCodeInput,
  PairingInstructionCard, PairingNameInput, PairingStepHeading, PairingWaitingIndicator,
} from './DevicePairingComponents';
import {
  DevicePairingStep, DeviceSetupCredential, devicePairingCommand, deviceTokenCommand,
  isCompletePairCode, pairingServerAddress, previousPairingStep, randomPairingDeviceName,
} from '../../../feature/devices/DevicePairingFlow';

/**
 * Add-device (pairing) screen.
 *
 * Port of `ui/screens/devices/AddDeviceScreen.kt` with the step bodies from
 * `DevicePairingSteps.kt`.
 *
 * The page is a 640dp-wide column under a 64dp header: back, the
 * `device_setup_page_title` title, and a close button that only appears once the
 * user has left the first step. The body scrolls with 18dp padding and 20dp
 * between elements, and the actions sit in a fixed footer 10dp apart.
 *
 * Flow rules, all from Android:
 *
 *  - leaving mid-flow asks first when a connector was created in this pass;
 *  - going back a step cancels the online wait;
 *  - the token and code steps need a credential, and fall back to Name if one is
 *    missing (the app was killed mid-flow, for instance);
 *  - the token step starts waiting for the device, and the wizard closes itself
 *    as soon as the device reports online.
 */
@Component
export struct AddDeviceScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  /** Current pairing step, owned by the app so the flow survives a redraw. */
  @Prop step: DevicePairingStep;
  @Prop credential: DeviceSetupCredential | undefined;
  /** True from the moment the connector is created until the wizard closes. */
  createdThisFlow: boolean = false;
  busy: boolean = false;
  waitingOnline: boolean = false;
  /** True once the device is actually online, which ends the flow. */
  deviceOnline: boolean = false;
  /** Message shown when leaving would abandon a created connector. */
  exitConfirmation: boolean = false;
  /** Wizard notices (create/claim/copy failures), surfaced as this screen's toast. */
  pairingNotice: ResourceStr = '';
  @Prop @Watch('onPairingNoticeChanged') pairingNoticeRequest: number;
  onBack: () => void = () => {};
  onLeave: () => void = () => {};
  onStep: (step: DevicePairingStep) => void = () => {};
  onCreateCredential: (name: string) => void = () => {};
  onClaimCode: (code: string) => void = () => {};
  onCopyError: () => void = () => {};
  onOpenDownload: () => void = () => {};
  onDismissExit: () => void = () => {};
  onConfirmExit: () => void = () => {};

  @State private name: string = '';
  @State private pairCode: string = '';
  private toast: AAToastState = new AAToastState();
  @State private toastRevision: number = 0;

  aboutToAppear(): void {
    if (this.name.length === 0) {
      this.name = randomPairingDeviceName();
    }
  }

  /** Android routes wizard failures through the page's snackbar host. */
  onPairingNoticeChanged(): void {
    if (this.pairingNoticeRequest > 0) {
      this.toast.show(this.pairingNotice, true);
      this.toastRevision += 1;
    }
  }

  private deviceName(): string {
    const credential: DeviceSetupCredential | undefined = this.credential;
    return credential === undefined ? this.name : credential.device.name;
  }

  private showError(message: ResourceStr): void {
    this.toast.show(message, true);
    this.toastRevision += 1;
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        this.Header()

        Scroll() {
          Column({ space: 20 }) {
            this.StepContent()
          }
          .width('100%')
          .padding({ left: 18, right: 18, top: 18, bottom: 18 })
          .alignItems(HorizontalAlign.Start)
        }
        .scrollBar(BarState.Off)
        .layoutWeight(1)
        .width('100%')

        Column({ space: 10 }) {
          this.StepActions()
        }
        .width('100%')
        .padding({ left: 18, right: 18, top: 10, bottom: 12 })
      }
      .width('100%')
      .height('100%')
      .constraintSize({ maxWidth: 640 })

      AAToastHost({
        colors: this.colors,
        message: this.toast.message,
        isError: this.toast.isError,
        actionLabel: this.toast.actionLabel,
        visible: this.toast.visible,
        onAction: () => this.toast.hide(),
      })

      if (this.exitConfirmation) {
        DeviceConfirmDialog({
          colors: this.colors,
          title: $r('app.string.device_pairing_exit_title'),
          body: this.waitingOnline
            ? $r('app.string.device_pairing_exit_waiting_description', this.deviceName())
            : $r('app.string.device_pairing_exit_description', this.deviceName()),
          dismissLabel: $r('app.string.device_pairing_continue_pairing'),
          confirmLabel: $r('app.string.device_pairing_close_anyway'),
          danger: false,
          busy: false,
          errorMessage: '',
          onDismiss: () => this.onDismissExit(),
          onConfirm: () => this.onConfirmExit(),
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
  }

  @Builder
  Header() {
    // iOS's pairing sheet chrome: an inline navigation bar whose trailing item is
    // the close glyph.
    AAIosInlineBar({
      colors: this.colors,
      title: $r('app.string.device_setup_page_title'),
      onBack: () => this.onBack(),
      trailingSlots: this.step === DevicePairingStep.ConnectionMethod ? 0 : 1,
    }) {
      if (this.step !== DevicePairingStep.ConnectionMethod) {
        Column() {
          AAIcon({ commands: AA_ICONS.X, iconSize: 20, color: this.colors.ink })
        }
        .width(44)
        .height(44)
        .justifyContent(FlexAlign.Center)
        // Android's `device_setup_close_content_description`.
        .accessibilityText($r('app.string.device_setup_close_content_description'))
        .onClick(() => this.onLeave())
      }
    }
  }

  /** The body of the current step, one branch per step as in Android. */
  @Builder
  StepContent() {
    if (this.step === DevicePairingStep.ConnectionMethod) {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_connection_title'),
        description: $r('app.string.device_pairing_connection_description'),
      })
      PairingChoiceCard({
        colors: this.colors,
        icon: AA_ICONS.MONITOR,
        title: $r('app.string.device_pairing_desktop_title'),
        description: $r('app.string.device_pairing_desktop_description'),
        onTap: () => this.onStep(DevicePairingStep.DesktopInstall),
      })
      PairingChoiceCard({
        colors: this.colors,
        icon: AA_ICONS.TERMINAL,
        title: $r('app.string.device_pairing_cli_title'),
        description: $r('app.string.device_pairing_cli_description'),
        onTap: () => this.onStep(DevicePairingStep.CliConfirm),
      })
    } else if (this.step === DevicePairingStep.DesktopInstall) {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_desktop_install_title'),
        description: $r('app.string.device_pairing_desktop_install_description'),
      })
      Column({ space: 12 }) {
        PairingInstructionCard({
          colors: this.colors,
          title: $r('app.string.device_pairing_desktop_download_title'),
          description: $r('app.string.device_pairing_desktop_install_step_download'),
        })
        PairingInstructionCard({
          colors: this.colors,
          title: $r('app.string.device_pairing_desktop_login_title'),
          description: $r('app.string.device_pairing_desktop_install_step_login'),
        })
        PairingInstructionCard({
          colors: this.colors,
          title: $r('app.string.device_pairing_desktop_online_title'),
          description: $r('app.string.device_pairing_desktop_install_step_online'),
        })
      }
      .width('100%')
    } else if (this.step === DevicePairingStep.CliConfirm) {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_command_warning_title'),
        description: $r('app.string.device_pairing_command_warning_description'),
      })
      PairingBodyText({
        colors: this.colors,
        text: $r('app.string.device_pairing_command_warning_fallback'),
      })
    } else if (this.step === DevicePairingStep.Name) {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_name_title'),
        description: $r('app.string.device_pairing_name_description'),
      })
      PairingNameInput({
        colors: this.colors,
        value: $name,
        fieldEnabled: !this.busy,
        onSubmit: () => this.onCreateCredential(this.name),
      })
    } else if (this.step === DevicePairingStep.CliMethod) {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_method_title'),
        description: $r('app.string.device_pairing_method_description', this.deviceName()),
      })
      PairingChoiceCard({
        colors: this.colors,
        icon: AA_ICONS.HASH,
        title: $r('app.string.device_pairing_pair_code_title'),
        description: $r('app.string.device_pairing_pair_code_description'),
        onTap: () => this.onStep(DevicePairingStep.PairCode),
      })
      PairingChoiceCard({
        colors: this.colors,
        icon: AA_ICONS.KEY_ROUND,
        title: $r('app.string.device_pairing_token_title'),
        description: $r('app.string.device_pairing_token_description'),
        onTap: () => this.onStep(DevicePairingStep.Command),
      })
    } else if (this.step === DevicePairingStep.Command) {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_command_step_title'),
        description: $r('app.string.device_pairing_command_step_description', this.deviceName()),
      })
      if (this.credential !== undefined) {
        PairingCodeBlock({
          colors: this.colors,
          code: deviceTokenCommand(this.credential),
          onCopyError: () => this.onCopyError(),
        })
        PairingBodyText({
          colors: this.colors,
          text: $r('app.string.device_pairing_linux_session_warning'),
        })
        PairingCodeBlock({
          colors: this.colors,
          code: `screen -S anywhere\n${deviceTokenCommand(this.credential)}`,
          onCopyError: () => this.onCopyError(),
        })
        PairingBodyText({
          colors: this.colors,
          text: $r('app.string.device_pairing_linux_detach_hint'),
        })
        PairingCodeBlock({
          colors: this.colors,
          code: 'screen -r anywhere',
          onCopyError: () => this.onCopyError(),
        })
      }
      if (this.waitingOnline) {
        PairingWaitingIndicator({
          colors: this.colors,
          label: $r('app.string.device_pairing_waiting_online'),
        })
      }
    } else {
      PairingStepHeading({
        colors: this.colors,
        title: $r('app.string.device_pairing_code_step_title'),
        description: $r('app.string.device_pairing_code_step_description', this.deviceName()),
      })
      if (this.credential !== undefined) {
        Column({ space: 12 }) {
          Text($r('app.string.device_pairing_pair_command'))
            .fontSize(14)
            .fontWeight(600)
            .fontColor(this.colors.ink)
            .width('100%')
          PairingCodeBlock({
            colors: this.colors,
            code: devicePairingCommand(pairingServerAddress(this.credential.serverUrl)),
            onCopyError: () => this.onCopyError(),
          })
          PairingBodyText({
            colors: this.colors,
            text: $r('app.string.device_pairing_pair_command_hint'),
          })
        }
        .width('100%')
        .padding(16)
        .borderRadius(18)
        .backgroundColor(this.colors.raisedSurface)
        .border({
          width: 1,
          color: this.colors.isDark ? this.colors.subtle : '#E7E6E2',
        })
        .alignItems(HorizontalAlign.Start)
      }
      PairingCodeInput({
        colors: this.colors,
        value: $pairCode,
        fieldEnabled: !this.busy,
        onSubmit: () => this.onClaimCode(this.pairCode),
      })
      if (this.busy) {
        PairingWaitingIndicator({
          colors: this.colors,
          label: $r('app.string.device_pairing_confirming'),
        })
      }
    }
  }

  /** The footer actions for the step, as Android's `DevicePairingStepActions`. */
  @Builder
  StepActions() {
    if (this.step === DevicePairingStep.DesktopInstall) {
      PairingActionButton({
        colors: this.colors,
        label: $r('app.string.device_pairing_download'),
        secondary: true,
        icon: AA_ICONS.EXTERNAL_LINK,
        onTap: () => this.onOpenDownload(),
      })
      PairingActionButton({
        colors: this.colors,
        label: $r('app.string.common_done'),
        onTap: () => this.onLeave(),
      })
    } else if (this.step === DevicePairingStep.CliConfirm) {
      PairingActionButton({
        colors: this.colors,
        label: $r('app.string.device_pairing_command_warning_desktop'),
        secondary: true,
        onTap: () => this.onStep(DevicePairingStep.DesktopInstall),
      })
      PairingActionButton({
        colors: this.colors,
        label: $r('app.string.device_pairing_command_warning_confirm'),
        onTap: () => this.onStep(DevicePairingStep.Name),
      })
    } else if (this.step === DevicePairingStep.Name) {
      PairingActionButton({
        colors: this.colors,
        label: $r('app.string.common_continue'),
        buttonEnabled: this.name.trim().length > 0,
        loading: this.busy,
        onTap: () => this.onCreateCredential(this.name.trim()),
      })
    } else if (this.step === DevicePairingStep.PairCode) {
      PairingActionButton({
        colors: this.colors,
        label: $r('app.string.device_pairing_claim'),
        buttonEnabled: isCompletePairCode(this.pairCode),
        loading: this.busy,
        onTap: () => this.onClaimCode(this.pairCode),
      })
    }
  }
}
