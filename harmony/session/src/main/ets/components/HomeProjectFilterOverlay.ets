import { APP_IS_DARK_KEY, getColors } from 'common';
import {
  PROJECT_STATUS_FILTER_ACTIVE,
  PROJECT_STATUS_FILTER_ARCHIVED,
  PROJECT_STATUS_FILTER_ALL
} from '../auth/HomeProjectPreferenceStore';
import { HomeMenuAnchor } from './HomeProjectActionMenuOverlay';

// A device entry shown in the filter menu. `label` is the display name and
// falls back to the device id when the name is blank (Android
// HomeProjectFilterMenu does the same).
export interface HomeFilterDeviceOption {
  id: string;
  label: string;
}

const FILTER_MENU_WIDTH = 286;
const FILTER_MENU_MAX_HEIGHT = 328;

// Anchored project filter menu mirroring Android HomeProjectFilterMenu +
// AAAnchoredDropdownMenu: a status section (Active / Archived / All), a device
// section and an agent section, plus a "Clear filters" entry in the header.
// Selecting an option keeps the menu open so several dimensions combine.
@Component
export struct HomeProjectFilterOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop anchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @Prop selectedStatus: string = PROJECT_STATUS_FILTER_ACTIVE;
  @Prop selectedDeviceId: string = '';
  @Prop selectedRuntime: string = '';
  @Prop devices: HomeFilterDeviceOption[] = [];
  @Prop devicesLoading: boolean = false;
  @Prop agents: string[] = [];
  @State overlayWidth: number = 0;
  @State overlayHeight: number = 0;
  @State menuHeight: number = FILTER_MENU_MAX_HEIGHT;
  onSelectStatus: (status: string) => void = () => {};
  onSelectDevice: (deviceId: string) => void = () => {};
  onSelectAgent: (runtime: string) => void = () => {};
  onClear: () => void = () => {};
  onDismiss: () => void = () => {};

  private filtersActive(): boolean {
    return this.selectedStatus !== PROJECT_STATUS_FILTER_ACTIVE || this.selectedDeviceId.length > 0 ||
      this.selectedRuntime.length > 0;
  }

  private menuX(): number {
    const margin = 12;
    const anchorRight = this.anchor.x + this.anchor.width;
    const preferred = anchorRight - FILTER_MENU_WIDTH;
    const max = Math.max(this.overlayWidth - FILTER_MENU_WIDTH - margin, margin);
    return Math.min(Math.max(preferred, margin), max);
  }

  private menuY(): number {
    const gap = 4;
    const margin = 12;
    const belowY = this.anchor.y + this.anchor.height + gap;
    if (belowY + this.menuHeight + margin <= this.overlayHeight) {
      return belowY;
    }
    return Math.max(this.anchor.y - this.menuHeight - gap, margin);
  }

  @Builder
  optionRow(label: ResourceStr | string, selected: boolean, onClick: () => void) {
    Row({ space: 12 }) {
      Text(label)
        .fontSize(14)
        .fontWeight(600)
        .lineHeight(19)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (selected) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(18)
          .fontColor([getColors().ink])
      } else {
        Column()
          .width(18)
          .height(18)
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      onClick();
    })
  }

  @Builder
  sectionLabel(label: ResourceStr) {
    Text(label)
      .fontSize(12)
      .fontColor(getColors().inkSoft)
      .opacity(0.72)
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })
  }

  @Builder
  sectionDivider() {
    Divider()
      .color(getColors().ink)
      .opacity(0.1)
      .margin({ top: 8, bottom: 8 })
  }

  build() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.onDismiss();
        })
      Scroll() {
        Column() {
          Row() {
            Text($r('app.string.home_project_session_status'))
              .fontSize(12)
              .fontColor(getColors().inkSoft)
              .opacity(0.72)
              .layoutWeight(1)
            if (this.filtersActive()) {
              Text($r('app.string.home_project_filter_clear'))
                .fontSize(14)
                .fontColor(getColors().primaryAction)
                .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                .onClick(() => {
                  this.onClear();
                })
            }
          }
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .padding({ left: 16, right: 8 })
          .alignItems(VerticalAlign.Center)
          this.optionRow($r('app.string.home_project_filter_active'),
            this.selectedStatus === PROJECT_STATUS_FILTER_ACTIVE, (): void => {
              this.onSelectStatus(PROJECT_STATUS_FILTER_ACTIVE);
            })
          this.optionRow($r('app.string.home_project_filter_archived'),
            this.selectedStatus === PROJECT_STATUS_FILTER_ARCHIVED, (): void => {
              this.onSelectStatus(PROJECT_STATUS_FILTER_ARCHIVED);
            })
          this.optionRow($r('app.string.home_project_filter_all'),
            this.selectedStatus === PROJECT_STATUS_FILTER_ALL, (): void => {
              this.onSelectStatus(PROJECT_STATUS_FILTER_ALL);
            })
          this.sectionDivider()
          this.sectionLabel($r('app.string.home_project_filter_devices'))
          this.optionRow($r('app.string.home_project_filter_all_devices'),
            this.selectedDeviceId.length === 0, (): void => {
              this.onSelectDevice('');
            })
          ForEach(this.devices, (device: HomeFilterDeviceOption) => {
            this.optionRow(device.label, this.selectedDeviceId === device.id, (): void => {
              this.onSelectDevice(device.id);
            })
          }, (device: HomeFilterDeviceOption) => device.id)
          if (this.devicesLoading) {
            Row() {
              LoadingProgress()
                .width(18)
                .height(18)
                .color(getColors().muted)
            }
            .width('100%')
            .height(36)
            .padding({ left: 16 })
            .justifyContent(FlexAlign.Start)
          }
          this.sectionDivider()
          this.sectionLabel($r('app.string.home_project_filter_agents'))
          this.optionRow($r('app.string.home_project_filter_all_agents'),
            this.selectedRuntime.length === 0, (): void => {
              this.onSelectAgent('');
            })
          ForEach(this.agents, (agent: string) => {
            this.optionRow(agent, this.selectedRuntime === agent, (): void => {
              this.onSelectAgent(agent);
            })
          }, (agent: string) => agent)
        }
        .width('100%')
        .padding({ top: 14, bottom: 14 })
      }
      .align(Alignment.TopStart)
      .width(FILTER_MENU_WIDTH)
      .constraintSize({ maxHeight: FILTER_MENU_MAX_HEIGHT })
      .borderRadius(18)
      .backgroundColor(this.themeIsDark ? getColors().subtle : getColors().raisedSurface)
      .border({ width: 1, color: this.themeIsDark ? Color.Transparent : getColors().border })
      .onAreaChange((_oldValue: Area, newValue: Area) => {
        const height = newValue.height;
        if (typeof height === 'number' && height > 0) {
          this.menuHeight = height;
        }
      })
      .position({ x: this.menuX(), y: this.menuY() })
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      const width = newValue.width;
      const height = newValue.height;
      if (typeof width === 'number') {
        this.overlayWidth = width;
      }
      if (typeof height === 'number') {
        this.overlayHeight = height;
      }
    })
  }
}
