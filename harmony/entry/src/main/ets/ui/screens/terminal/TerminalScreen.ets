import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAIosInlineBar } from '../../designsystem/AAIosChrome';
import { AppEmptyState } from '../common/AppEmptyState';
import { AgentDevice } from '../../../model/AgentSession';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import { sortedForDevicesPage } from '../../../feature/devices/DeviceAgentPreviews';
import { RemoteTerminalPool } from '../../../feature/terminal/RemoteTerminalPool';
import { RemoteTerminalController } from '../../../feature/terminal/RemoteTerminalController';
import { TerminalContent } from './TerminalContent';

/**
 * Terminal page.
 *
 * Port of `ui/screens/terminal/TerminalScreen.kt`.
 *
 * The page is a device picker over one terminal: a 64dp header with a 40dp back
 * button and a 44dp chip that opens the device menu, then either the terminal
 * itself, a centred explanation when every device is offline, or the shared
 * empty state prompting a pairing.
 *
 * The terminal is chosen by the first online device and follows the picker; when
 * the chosen device goes offline, the first online one takes over — the same
 * `LaunchedEffect(devices)` Android runs.
 */
@Component
export struct TerminalScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  state: SessionsState = SessionsState.empty();
  pool: RemoteTerminalPool | null = null;
  /** Device to open on, when the page that opened this one already knew it. */
  initialDeviceId: string = '';
  onBack: () => void = () => {};
  onPairDevice: () => void = () => {};

  @State private selectedDeviceId: string = '';
  @State private pickerOpen: boolean = false;

  aboutToAppear(): void {
    if (this.initialDeviceId.length > 0) {
      this.selectedDeviceId = this.initialDeviceId;
    }
    this.ensureDevice();
  }

  private devices(): AgentDevice[] {
    return sortedForDevicesPage(this.state.devices);
  }

  private selectedDevice(): AgentDevice | null {
    for (const device of this.devices()) {
      if (device.id === this.selectedDeviceId && device.online) {
        return device;
      }
    }
    return null;
  }

  private controller(): RemoteTerminalController | null {
    const pool: RemoteTerminalPool | null = this.pool;
    const device: AgentDevice | null = this.selectedDevice();
    if (pool === null || device === null) {
      return null;
    }
    return pool.forDevice(device.id);
  }

  /** Keeps the picker on an online device. */
  private ensureDevice(): void {
    const devices: AgentDevice[] = this.devices();
    for (const device of devices) {
      if (device.id === this.selectedDeviceId && device.online) {
        return;
      }
    }
    for (const device of devices) {
      if (device.online) {
        this.selectedDeviceId = device.id;
        return;
      }
    }
    this.selectedDeviceId = '';
  }

  private selectDevice(device: AgentDevice): void {
    this.pickerOpen = false;
    if (!device.online) {
      return;
    }
    this.selectedDeviceId = device.id;
  }

  build() {
    Column() {
      this.Header()

      if (this.devices().length === 0) {
        AppEmptyState({
          colors: this.colors,
          message: $r('app.string.terminal_pair_first'),
          buttonLabel: $r('app.string.home_pair_new_device'),
          buttonIconCommands: AA_ICONS.MONITOR,
          onButtonClick: () => this.onPairDevice(),
        })
          .layoutWeight(1)
      } else if (this.selectedDevice() === null) {
        this.EmptyMessage($r('app.string.terminal_all_devices_offline'))
      } else {
        TerminalContent({
          colors: this.colors,
          darkMode: this.colors.isDark,
          controller: this.controller(),
          terminalKey: this.selectedDeviceId,
          canReconnect: true,
          onStart: () => {
            const device: AgentDevice | null = this.selectedDevice();
            const controller: RemoteTerminalController | null = this.controller();
            if (device !== null && controller !== null) {
              void controller.ensureStartedDevice(device);
            }
          },
          onReconnect: () => {
            const device: AgentDevice | null = this.selectedDevice();
            const controller: RemoteTerminalController | null = this.controller();
            if (device !== null && controller !== null) {
              void controller.reconnectDevice(device);
            }
          },
          onClear: () => {
            const device: AgentDevice | null = this.selectedDevice();
            const controller: RemoteTerminalController | null = this.controller();
            if (device !== null && controller !== null) {
              void controller.restartDevice(device);
            }
          },
        })
          .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  EmptyMessage(text: ResourceStr) {
    Column() {
      Text(text)
        .fontSize(14)
        .lineHeight(19)
        .fontWeight(600)
        .fontColor(this.colors.isDark ? '#A1A1AA' : '#6F706A')
        .textAlign(TextAlign.Center)
        .padding({ left: 34, right: 34 })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  /** iOS's inline navigation bar: the device name, with the picker as a glyph. */
  @Builder
  Header() {
    AAIosInlineBar({
      colors: this.colors,
      title: this.selectedDevice() === null
        ? $r('app.string.devices_no_online')
        : (this.selectedDevice() as AgentDevice).name,
      onBack: () => this.onBack(),
      trailingSlots: 1,
    }) {
      // Android's bordered device chip becomes iOS's trailing picker glyph; the
      // menu, its items and the enabled rule are unchanged.
      Column() {
        AAIcon({ commands: AA_ICONS.CHEVRON_DOWN, iconSize: 20, color: this.colors.ink })
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .accessibilityText($r('app.string.devices_title'))
      .onClick(() => {
        if (this.devices().length > 0) {
          this.pickerOpen = !this.pickerOpen;
        }
      })
      .bindMenu(this.pickerOpen, this.DevicePicker(), {
        placement: Placement.BottomRight,
        enableArrow: false,
        onDisappear: () => {
          this.pickerOpen = false;
        },
      })
    }
  }

  @Builder
  DevicePicker() {
    Column() {
      ForEach(this.devices(), (device: AgentDevice) => {
        Row({ space: 10 }) {
          AAIcon({
            commands: AA_ICONS.MONITOR,
            iconSize: 18,
            color: device.online ? this.colors.inkSoft : this.colors.faint,
          })
          Text(device.name)
            .fontSize(15)
            .fontWeight(device.id === this.selectedDeviceId ? FontWeight.Bold : FontWeight.Normal)
            .fontColor(device.online ? this.colors.ink : this.colors.faint)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          if (device.id === this.selectedDeviceId) {
            AAIcon({ commands: AA_ICONS.CHECK, iconSize: 16, color: this.colors.sessionStatusAccent })
          }
        }
        .width(230)
        .height(44)
        .padding({ left: 14, right: 14 })
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          this.selectDevice(device);
        })
      }, (device: AgentDevice) => `picker-${device.id}`)
    }
    .padding({ top: 6, bottom: 6 })
    .borderRadius(14)
    .backgroundColor(this.colors.raisedSurface)
  }
}
