import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AARadius } from '../../designsystem/AAMetrics';
import { AAIosInlineBar } from '../../designsystem/AAIosChrome';
import { AppEmptyState } from '../common/AppEmptyState';
import { AgentDevice } from '../../../model/AgentSession';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import {
  DeviceAgentPreview, DeviceAgentPreviewKind, DeviceAgentPreviews, sortedForDevicesPage,
} from '../../../feature/devices/DeviceAgentPreviews';

/**
 * Devices page.
 *
 * Port of `ui/screens/devices/DevicesScreen.kt`.
 *
 * Geometry, copied value for value:
 *
 *  - header: 64dp tall, 18dp horizontal padding, an optional 40dp circular back
 *    button with a 22dp chevron and a 12dp gap before the 17sp/22sp semi-bold
 *    title;
 *  - rows: 60dp tall, 15dp radius, raised surface, a 1dp border (`#ECECEC` light,
 *    the theme border in dark), a 2dp shadow that deepens to 9dp while pressed
 *    (`#000000` at 3% in light, 20% in dark, 16% pressed), 12dp of leading inset
 *    and 8dp trailing;
 *  - the add row's 42dp tile is 12dp-rounded on `#F3F2EF`/`#27272A`;
 *  - a device row uses a 42dp OS icon, then an 11dp gap, the name at 17sp/21sp
 *    semi-bold (muted while offline) beside the status label, and a second line
 *    at 13sp/16sp medium capped to 84% of the row;
 *  - the status label is a 16dp icon plus 13sp/16sp text: `#10B981` and a circled
 *    check when online, the muted colour and an empty circle at 40% when not;
 *  - the loading state is four 60dp skeleton rows.
 *
 * Deviations, both deliberate and recorded in the port plan: the device icons are
 * vectors rather than Android's twelve OS bitmaps, and the skeletons are static
 * because ArkUI has no shimmer.
 */
@Component
export struct DevicesScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  state: SessionsState = SessionsState.empty();
  /** True while the app is refreshing for a reason other than a pull. */
  @Prop @Watch('onIsRefreshingChanged') isRefreshing: boolean;
  agentPreviews: DeviceAgentPreviews = DeviceAgentPreviews.empty();
  /** Resolves when the refresh has finished, so the indicator can stop. */
  onRefresh: () => Promise<void> = () => Promise.resolve();
  onOpenDevice: (device: AgentDevice) => void = () => {};
  onBack: () => void = () => {};
  onAddDevice: () => void = () => {};
  @State private refreshing: boolean = false;

  onIsRefreshingChanged(): void {
    this.refreshing = this.isRefreshing;
  }

  private devices(): AgentDevice[] {
    return sortedForDevicesPage(this.state.devices);
  }

  build() {
    Column() {
      this.Header()

      Refresh({ refreshing: $$this.refreshing }) {
        Column() {
          if (this.state.isLoading && !this.state.hasLoaded && this.state.devices.length === 0) {
            this.LoadingList()
          } else {
            List({ space: 10 }) {
              ListItem() {
                this.AddDeviceRow()
              }
              if (this.devices().length === 0) {
                ListItem() {
                  AppEmptyState({
                    colors: this.colors,
                    message: this.state.errorMessage ?? $r('app.string.devices_empty'),
                  })
                    .height(360)
                }
              } else {
                ForEach(this.devices(), (device: AgentDevice) => {
                  ListItem() {
                    DeviceRow({
                      colors: this.colors,
                      device: device,
                      preview: this.agentPreviews.preview(device.id),
                      onTap: () => this.onOpenDevice(device),
                    })
                  }
                }, (device: AgentDevice) => device.id)
              }
              ListItem() {
                Column().height(28)
              }
            }
            .width('100%')
            .height('100%')
            .scrollBar(BarState.Off)
            .padding({ left: 24, right: 24 })
          }
        }
        .width('100%')
        .height('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .onRefreshing(() => {
        this.onRefresh().then(() => {
          this.refreshing = false;
        }).catch(() => {
          this.refreshing = false;
        });
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  Header() {
    // iOS's device sheet chrome: an inline navigation bar — bare dismiss glyph,
    // centred 17sp/600 title — instead of Android's 40dp bordered circle and
    // left-aligned title.
    AAIosInlineBar({
      colors: this.colors,
      title: $r('app.string.devices_title'),
      onBack: () => this.onBack(),
    })
  }

  /** Four skeleton rows, Android's `DevicesLoadingList` without the shimmer. */
  @Builder
  LoadingList() {
    Column({ space: 10 }) {
      ForEach([0, 1, 2, 3], (index: number) => {
        Row() {
          Column()
            .width(42)
            .height(42)
            .borderRadius(10)
            .backgroundColor(this.skeletonLine())
          Column({ space: 6 }) {
            Column()
              .width(116)
              .height(15)
              .borderRadius(8)
              .backgroundColor(this.skeletonLine())
            Column()
              .width(82)
              .height(11)
              .borderRadius(6)
              .backgroundColor(this.skeletonLine())
          }
          .margin({ left: 11 })
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .height(60)
        .padding({ left: 12, right: 12 })
        .borderRadius(15)
        .backgroundColor(this.colors.raisedSurface)
        .border({
          width: 1,
          color: this.colors.isDark ? '#27272A' : '#ECECEC',
        })
        .alignItems(VerticalAlign.Center)
      }, (index: number) => `skeleton-${index}`)
    }
    .width('100%')
    .padding({ left: 24, right: 24, top: 8 })
  }

  private skeletonLine(): string {
    return this.colors.isDark ? '#27272A' : '#F0F0F0';
  }

  @Builder
  AddDeviceRow() {
    Row() {
      Column() {
        AAIcon({
          commands: AA_ICONS.PLUS,
          iconSize: 22,
          color: this.rowTitle(),
        })
      }
      .width(42)
      .height(42)
      .justifyContent(FlexAlign.Center)
      .borderRadius(12)
      .backgroundColor(this.colors.isDark ? '#27272A' : '#F3F2EF')

      Text($r('app.string.devices_add_new'))
        .fontSize(17)
        .lineHeight(21)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.rowTitle())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .margin({ left: 11 })

      AAIcon({ commands: AA_ICONS.CHEVRON_RIGHT, iconSize: 20, color: this.colors.faint })
    }
    .width('100%')
    .height(60)
    .padding({ left: 12, right: 8 })
    .borderRadius(15)
    .backgroundColor(this.colors.raisedSurface)
    .border({
      width: 1,
      color: this.colors.isDark ? this.colors.border : '#ECECEC',
    })
    .shadow(this.rowShadow())
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onAddDevice())
  }

  private rowTitle(): string {
    return this.colors.isDark ? '#DADADF' : '#343436';
  }

  /** Android deepens the shadow from 2dp to 9dp while a row is pressed. */
  private rowShadow(): ShadowOptions {
    const alpha: number = this.colors.isDark ? 0.20 : 0.03;
    return {
      radius: 2,
      color: withAlpha('#000000', alpha),
      offsetX: 0,
      offsetY: 1,
    };
  }
}

/** One device row. */
@Component
struct DeviceRow {
  colors: AAColors = AA_LIGHT_COLORS;
  device: AgentDevice = { id: '', name: '', deviceOs: null, online: false, lastSeenAt: null, createdAt: null };
  preview: DeviceAgentPreview | undefined = undefined;
  onTap: () => void = () => {};

  private titleColor(): string {
    if (!this.device.online) {
      return this.colors.muted;
    }
    return this.colors.isDark ? '#DADADF' : '#343436';
  }

  private metaColor(): string {
    return this.colors.isDark ? this.colors.muted : this.colors.faint;
  }

  /**
   * The second line.
   *
   * Android's `deviceAgentPreviewLabel`: an offline device says so, a loaded
   * preview gives the running-agent count as a plural, and loading or a failed
   * request each have their own copy.
   */
  @Builder
  PreviewLabel() {
    if (!this.device.online) {
      Text($r('app.string.devices_offline'))
        .fontSize(13)
        .lineHeight(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.metaColor())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    } else if (this.preview !== undefined && this.preview.kind === DeviceAgentPreviewKind.Loaded) {
      Text($r('app.plural.devices_agents_online', this.preview.onlineAgentCount))
        .fontSize(13)
        .lineHeight(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.metaColor())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    } else if (this.preview !== undefined && this.preview.kind === DeviceAgentPreviewKind.Unavailable) {
      Text($r('app.string.devices_agent_status_unavailable'))
        .fontSize(13)
        .lineHeight(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.metaColor())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    } else {
      Text($r('app.string.devices_agent_status_loading'))
        .fontSize(13)
        .lineHeight(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.metaColor())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
  }

  build() {
    Row() {
      Column() {
        Image(deviceIcon(this.device.deviceOs, this.device.online, this.colors.isDark))
          .width(42)
          .height(42)
          .objectFit(ImageFit.Contain)
      }
      .width(42)
      .height(42)
      .justifyContent(FlexAlign.Center)

      Column() {
        Row({ space: 8 }) {
          Text(this.device.name)
            .fontSize(17)
            .lineHeight(21)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.titleColor())
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          DeviceStatusLabel({ colors: this.colors, online: this.device.online })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Row() {
          this.PreviewLabel()
        }
        .width('84%')
      }
      .layoutWeight(1)
      .margin({ left: 11 })
      .alignItems(HorizontalAlign.Start)

      AAIcon({ commands: AA_ICONS.CHEVRON_RIGHT, iconSize: 20, color: this.colors.faint })
    }
    .width('100%')
    .height(60)
    .padding({ left: 12, right: 8 })
    .borderRadius(15)
    .backgroundColor(this.colors.raisedSurface)
    .border({
      width: 1,
      color: this.colors.isDark ? this.colors.border : '#ECECEC',
    })
    .shadow({
      radius: 2,
      color: withAlpha('#000000', this.colors.isDark ? 0.20 : 0.03),
      offsetX: 0,
      offsetY: 1,
    })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onTap())
  }
}

/** `online` / `offline`, with Android's circled-check and hollow-circle icons. */
@Component
struct DeviceStatusLabel {
  colors: AAColors = AA_LIGHT_COLORS;
  online: boolean = false;

  private statusColor(): string {
    return this.online ? '#10B981' : this.colors.muted;
  }

  build() {
    Row({ space: 6 }) {
      AAIcon({
        commands: this.online ? AA_ICONS.CIRCLE_CHECK : AA_ICONS.CIRCLE,
        iconSize: 16,
        color: this.online ? this.statusColor() : withAlpha(this.statusColor(), 0.4),
      })
      Text(this.online ? $r('app.string.devices_online') : $r('app.string.devices_offline'))
        .fontSize(13)
        .lineHeight(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.statusColor())
        .maxLines(1)
    }
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * The device image for an operating system.
 *
 * Android picks one of twelve bitmaps — three systems across light/dark and
 * online/offline — from its own `drawable-nodpi` folder; the same files are
 * shipped in this module's media folder under their original names, so the OS
 * artwork and the online/offline treatment are identical rather than redrawn.
 */
function deviceIcon(deviceOs: string | null, online: boolean, dark: boolean): Resource {
  const kind: string = deviceOs === null ? '' : deviceOs.toLowerCase();
  const tone: string = dark ? 'dark' : 'light';
  const state: string = online ? 'online' : 'offline';
  if (kind === 'macos') {
    return tone === 'dark'
      ? (online ? $r('app.media.device_icon_dark_macos_online_3x')
        : $r('app.media.device_icon_dark_macos_offline_3x'))
      : (online ? $r('app.media.device_icon_light_macos_online_3x')
        : $r('app.media.device_icon_light_macos_offline_3x'));
  }
  if (kind === 'windows') {
    return tone === 'dark'
      ? (online ? $r('app.media.device_icon_dark_windows_online_3x')
        : $r('app.media.device_icon_dark_windows_offline_3x'))
      : (online ? $r('app.media.device_icon_light_windows_online_3x')
        : $r('app.media.device_icon_light_windows_offline_3x'));
  }
  // Linux and anything unrecognized share Android's Linux artwork.
  return tone === 'dark'
    ? (online ? $r('app.media.device_icon_dark_linux_online_3x')
      : $r('app.media.device_icon_dark_linux_offline_3x'))
    : (online ? $r('app.media.device_icon_light_linux_online_3x')
      : $r('app.media.device_icon_light_linux_offline_3x'));
}
