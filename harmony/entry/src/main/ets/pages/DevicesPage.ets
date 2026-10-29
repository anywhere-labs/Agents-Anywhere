import { ApiClient } from 'network';
import { DevicesApi, RemoteDevice } from 'network';
import { SharedApiClient } from 'session';
import { AuthSessionStore } from 'session';
import { errorMessageFrom } from 'common';
import { APP_IS_DARK_KEY, getColors } from 'common';

// Online-agent preview for a device row, mirrors android
// DeviceAgentPreviewState: count >= 0 loaded, -1 unavailable.
interface DevicePreviewEntry {
  deviceId: string;
  count: number;
}

@Component
export struct DevicesPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State loading: boolean = true;
  @State refreshing: boolean = false;
  @State errorMessage: string = '';
  @State devices: RemoteDevice[] = [];
  @State previewEntries: DevicePreviewEntry[] = [];
  private navPathStack: NavPathStack = new NavPathStack();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private previewsRequestSeq: number = 0;
  private shownOnce: boolean = false;

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private localized(resource: Resource): string {
    return getContext(this).resourceManager.getStringSync(resource);
  }

  // getStringSync does not substitute $r format params, so replace the
  // "%d" placeholder manually.
  private localizedWithCount(resource: Resource, count: number): string {
    return this.localized(resource).replace('%d', count.toString());
  }

  // Mirrors android sortedForDevicesPage: online first, then createdAt
  // ascending, then name ascending.
  private sortedDevices(): RemoteDevice[] {
    const sorted = this.devices.slice();
    sorted.sort((left: RemoteDevice, right: RemoteDevice): number => {
      const leftOnline = left.status === 'online' ? 1 : 0;
      const rightOnline = right.status === 'online' ? 1 : 0;
      if (leftOnline !== rightOnline) {
        return rightOnline - leftOnline;
      }
      const leftCreated = left.createdAt ?? '';
      const rightCreated = right.createdAt ?? '';
      if (leftCreated !== rightCreated) {
        return leftCreated < rightCreated ? -1 : 1;
      }
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      if (leftName !== rightName) {
        return leftName < rightName ? -1 : 1;
      }
      return 0;
    });
    return sorted;
  }

  // Mirrors android onlineAgentCount: configured + active + running.
  private onlineAgentCount(deviceId: string, seq: number): void {
    this.devicesApi.listDeviceRuntimes(this.serverUrl(), this.token(), deviceId)
      .then((list) => {
        let count = 0;
        for (const runtime of list.runtimes) {
          if (runtime.configured && runtime.active && runtime.status === 'running') {
            count++;
          }
        }
        this.setPreviewEntry(deviceId, count, seq);
      })
      .catch(() => {
        this.setPreviewEntry(deviceId, -1, seq);
      });
  }

  private setPreviewEntry(deviceId: string, count: number, seq: number): void {
    if (this.previewsRequestSeq !== seq) {
      return;
    }
    const next: DevicePreviewEntry[] = [];
    let replaced = false;
    for (const entry of this.previewEntries) {
      if (entry.deviceId === deviceId) {
        const updated: DevicePreviewEntry = { deviceId: deviceId, count: count };
        next.push(updated);
        replaced = true;
      } else {
        next.push(entry);
      }
    }
    if (!replaced) {
      const created: DevicePreviewEntry = { deviceId: deviceId, count: count };
      next.push(created);
    }
    this.previewEntries = next;
  }

  // Mirrors android DeviceAgentPreviews.beginRefresh: keep loaded counts for
  // devices that are still online, reset everything else to loading.
  private refreshPreviews(): void {
    this.previewsRequestSeq++;
    const seq = this.previewsRequestSeq;
    const kept: DevicePreviewEntry[] = [];
    for (const device of this.devices) {
      if (device.status !== 'online') {
        continue;
      }
      for (const entry of this.previewEntries) {
        if (entry.deviceId === device.id && entry.count >= 0) {
          kept.push(entry);
        }
      }
    }
    this.previewEntries = kept;
    for (const device of this.devices) {
      if (device.status === 'online') {
        this.onlineAgentCount(device.id, seq);
      }
    }
  }

  private previewCountFor(deviceId: string): number {
    for (const entry of this.previewEntries) {
      if (entry.deviceId === deviceId) {
        return entry.count;
      }
    }
    return -2;
  }

  // Mirrors android deviceAgentPreviewLabel.
  private previewLabel(device: RemoteDevice): string {
    if (device.status !== 'online') {
      return this.localized($r('app.string.devices_offline'));
    }
    const count = this.previewCountFor(device.id);
    if (count >= 0) {
      if (count === 1) {
        return this.localizedWithCount($r('app.string.devices_agents_online_one'), count);
      }
      return this.localizedWithCount($r('app.string.devices_agents_online_other'), count);
    }
    if (count === -1) {
      return this.localized($r('app.string.devices_agent_status_unavailable'));
    }
    return this.localized($r('app.string.devices_agent_status_loading'));
  }

  private async loadDevices(): Promise<void> {
    try {
      this.devices = await this.devicesApi.listDevices(this.serverUrl(), this.token());
      this.errorMessage = '';
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.loading = false;
    this.refreshing = false;
    this.refreshPreviews();
  }

  private openPairing(): void {
    this.navPathStack.pushPathByName('pairing', '');
  }

  private openDevice(device: RemoteDevice): void {
    this.navPathStack.pushPathByName('device_detail', device.id);
  }

  // --- Row colors (mirrors android DevicesScreen local palette) ------------

  private rowTitleColor(): string {
    if (this.themeIsDark) {
      return '#DADADF';
    }
    return '#343436';
  }

  private rowMetaColor(): string {
    if (this.themeIsDark) {
      return getColors().muted;
    }
    return getColors().faint;
  }

  private rowBorderColor(): string {
    if (this.themeIsDark) {
      return getColors().border;
    }
    return '#ECECEC';
  }

  private iconBoxColor(): string {
    if (this.themeIsDark) {
      return '#27272A';
    }
    return '#F3F2EF';
  }

  private statusColor(device: RemoteDevice): string {
    if (device.status === 'online') {
      return '#10B981';
    }
    return getColors().muted;
  }

  // Mirrors android deviceKind: macos -> desktop, windows -> computer,
  // linux/generic -> pc.
  private deviceIcon(device: RemoteDevice): Resource {
    const os = (device.deviceOs ?? '').toLowerCase();
    if (os === 'macos') {
      return $r('sys.symbol.desktop');
    }
    if (os === 'windows') {
      return $r('sys.symbol.computer');
    }
    return $r('sys.symbol.pc');
  }

  // --- Builders --------------------------------------------------------------

  @Builder
  addDeviceRow() {
    Row() {
      Row() {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(22)
          .fontColor([this.rowTitleColor()])
      }
      .width(42)
      .height(42)
      .borderRadius(12)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.iconBoxColor())

      Text($r('app.string.devices_add_new'))
        .fontSize(17)
        .fontWeight(600)
        .lineHeight(21)
        .fontColor(this.rowTitleColor())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .margin({ left: 11 })

      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(20)
        .fontColor([getColors().faint])
    }
    .width('100%')
    .height(60)
    .padding({ left: 12, right: 8 })
    .borderRadius(15)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: this.rowBorderColor() })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.openPairing();
    })
  }

  @Builder
  deviceStatusLabel(device: RemoteDevice) {
    Row({ space: 6 }) {
      SymbolGlyph(device.status === 'online' ? $r('sys.symbol.checkmark_circle') : $r('sys.symbol.circle'))
        .fontSize(16)
        .fontColor([this.statusColor(device)])
        .opacity(device.status === 'online' ? 1 : 0.4)
      Text(device.status === 'online' ? $r('app.string.devices_online') : $r('app.string.devices_offline'))
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .lineHeight(16)
        .fontColor(this.statusColor(device))
        .maxLines(1)
    }
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  deviceRow(device: RemoteDevice) {
    Row() {
      Row() {
        SymbolGlyph(this.deviceIcon(device))
          .fontSize(22)
          .fontColor([device.status === 'online' ? this.rowTitleColor() : getColors().muted])
      }
      .width(42)
      .height(42)
      .borderRadius(12)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.iconBoxColor())

      Column({ space: 3 }) {
        Row({ space: 8 }) {
          Text(device.name)
            .fontSize(17)
            .fontWeight(600)
            .lineHeight(21)
            .fontColor(device.status === 'online' ? this.rowTitleColor() : getColors().muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .constraintSize({ maxWidth: '68%' })
          this.deviceStatusLabel(device)
        }
        .alignItems(VerticalAlign.Center)

        Text(this.previewLabel(device))
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .lineHeight(16)
          .fontColor(this.rowMetaColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 11 })

      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(20)
        .fontColor([getColors().faint])
    }
    .width('100%')
    .height(60)
    .padding({ left: 12, right: 8 })
    .borderRadius(15)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: this.rowBorderColor() })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.openDevice(device);
    })
  }

  build() {
    NavDestination() {
      Column() {
        if (this.loading) {
          Column() {
            LoadingProgress()
              .width(44)
              .height(44)
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          Refresh({ refreshing: $$this.refreshing }) {
            List({ space: 10 }) {
              ListItem() {
                this.addDeviceRow()
              }
              if (this.devices.length === 0) {
                ListItem() {
                  Column() {
                    if (this.errorMessage.length > 0) {
                      Text(this.errorMessage)
                        .fontSize(16)
                        .fontWeight(FontWeight.Medium)
                        .lineHeight(21.5)
                        .fontColor(getColors().inkSoft)
                        .textAlign(TextAlign.Center)
                    } else {
                      Text($r('app.string.devices_no_devices'))
                        .fontSize(16)
                        .fontWeight(FontWeight.Medium)
                        .lineHeight(21.5)
                        .fontColor(getColors().inkSoft)
                        .textAlign(TextAlign.Center)
                    }
                  }
                  .width('100%')
                  .padding({ top: 96, bottom: 96 })
                  .alignItems(HorizontalAlign.Center)
                }
              }
              ForEach(this.sortedDevices(), (device: RemoteDevice) => {
                ListItem() {
                  this.deviceRow(device)
                }
              // Key includes the preview count so loaded agent-status labels
              // rebuild the row instead of keeping the stale "Loading" text.
              }, (device: RemoteDevice) =>
                `${device.id}_${device.name}_${device.status}_${this.previewCountFor(device.id)}`)
            }
            .width('100%')
            .layoutWeight(1)
            .padding({ left: 24, right: 24, top: 8, bottom: 28 })
          }
          .onRefreshing(() => {
            this.loadDevices();
          })
          .width('100%')
          .layoutWeight(1)
        }
      }
      .width('100%')
      .height('100%')
    }
    .title($r('app.string.devices_title'))
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      this.loadDevices();
    })
    .onShown(() => {
      if (this.shownOnce) {
        this.loadDevices();
      } else {
        this.shownOnce = true;
      }
    })
  }
}

@Builder
export function DevicesPageBuilder() {
  DevicesPage()
}
