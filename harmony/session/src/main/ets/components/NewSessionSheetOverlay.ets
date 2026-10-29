import { RemoteDevice, RemoteDeviceRuntime } from 'network';
import { APP_IS_DARK_KEY, getColors } from 'common';

export interface NewSessionPendingAttachment {
  localId: string;
  name: string;
  size: number;
}

export interface NewSessionCatalogOption {
  id: string;
  label: string;
  description: string | null;
  selected: boolean;
  enabled: boolean;
}

export interface NewSessionCatalogView {
  loading: boolean;
  errorText: string;
  modelUnavailable: boolean;
  permissionUnavailable: boolean;
  models: NewSessionCatalogOption[];
  efforts: NewSessionCatalogOption[];
  permissions: NewSessionCatalogOption[];
}

export interface NewSessionBrowserEntryView {
  name: string;
  path: string;
}

export interface NewSessionBrowserView {
  visible: boolean;
  loading: boolean;
  errorText: string;
  path: string;
  entries: NewSessionBrowserEntryView[];
  canGoUp: boolean;
}

export function emptyNewSessionCatalogView(): NewSessionCatalogView {
  const view: NewSessionCatalogView = {
    loading: false,
    errorText: '',
    modelUnavailable: false,
    permissionUnavailable: false,
    models: [],
    efforts: [],
    permissions: []
  };
  return view;
}

export function emptyNewSessionBrowserView(): NewSessionBrowserView {
  const view: NewSessionBrowserView = {
    visible: false,
    loading: false,
    errorText: '',
    path: '',
    entries: [],
    canGoUp: false
  };
  return view;
}

@Component
export struct NewSessionSheetOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop devices: RemoteDevice[] = [];
  @Prop runtimes: RemoteDeviceRuntime[] = [];
  @Prop runtimesLoading: boolean = false;
  @Prop selectedDeviceId: string = '';
  @Prop selectedRuntimeId: string = '';
  @Prop setupState: string = 'checking';
  @Prop titleInput: string = '';
  @Prop cwdInput: string = '';
  @Prop messageInput: string = '';
  @Prop catalog: NewSessionCatalogView = emptyNewSessionCatalogView();
  @Prop browser: NewSessionBrowserView = emptyNewSessionBrowserView();
  @Prop startEnabled: boolean = false;
  @Prop creating: boolean = false;
  @Prop errorText: string = '';
  @Prop attachments: NewSessionPendingAttachment[] = [];
  @Prop pickingAttachment: boolean = false;
  onTitleChange: (value: string) => void = () => {};
  onDeviceSelected: (deviceId: string) => void = () => {};
  onRuntimeSelected: (runtime: RemoteDeviceRuntime) => void = () => {};
  onModelSelected: (modelId: string) => void = () => {};
  onEffortSelected: (effortId: string) => void = () => {};
  onPermissionSelected: (permissionId: string) => void = () => {};
  onRetryRuntimeDetails: () => void = () => {};
  onCwdChange: (value: string) => void = () => {};
  onMessageChange: (value: string) => void = () => {};
  onChooseDirectory: () => void = () => {};
  onBrowserUp: () => void = () => {};
  onBrowserEntrySelected: (path: string) => void = () => {};
  onBrowserRetry: () => void = () => {};
  onUseDirectory: () => void = () => {};
  onPickPhotos: () => void = () => {};
  onPickFiles: () => void = () => {};
  onRemoveAttachment: (localId: string) => void = () => {};
  onRetrySetup: () => void = () => {};
  onViewDevices: () => void = () => {};
  onCreate: () => void = () => {};
  onClose: () => void = () => {};

  private attachmentSizeLabel(size: number): string {
    if (size >= 1048576) {
      const mb = Math.round(size / 104857.6) / 10;
      return `${mb} MB`;
    }
    if (size >= 1024) {
      const kb = Math.round(size / 102.4) / 10;
      return `${kb} KB`;
    }
    return `${size} B`;
  }

  private startButtonLabel(): ResourceStr {
    if (this.creating) {
      return $r('app.string.new_session_starting');
    }
    return $r('app.string.new_session_start_chat');
  }

  private optionChipColor(option: NewSessionCatalogOption): string {
    if (option.selected) {
      return getColors().primaryAction;
    }
    return getColors().subtle;
  }

  private optionChipTextColor(option: NewSessionCatalogOption): string {
    if (option.selected) {
      return getColors().onPrimaryAction;
    }
    if (option.enabled) {
      return getColors().ink;
    }
    return getColors().faint;
  }

  @Builder
  sectionLabel(label: ResourceStr) {
    Text(label)
      .fontSize(13)
      .fontWeight(FontWeight.Medium)
      .fontColor(getColors().muted)
      .width('100%')
  }

  @Builder
  deviceChip(device: RemoteDevice) {
    Row({ space: 6 }) {
      Circle()
        .width(6)
        .height(6)
        .fill(device.status === 'online' ? getColors().runtimeRunning : getColors().faint)
      Text(device.name)
        .fontSize(13)
        .fontColor(this.selectedDeviceId === device.id ? getColors().onPrimaryAction : getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .padding({ left: 12, right: 12, top: 7, bottom: 7 })
    .borderRadius(16)
    .backgroundColor(this.selectedDeviceId === device.id ? getColors().primaryAction : getColors().subtle)
    .margin({ right: 8, bottom: 8 })
    .onClick(() => {
      this.onDeviceSelected(device.id);
    })
  }

  @Builder
  runtimeChip(runtime: RemoteDeviceRuntime) {
    Text(runtime.displayName)
      .fontSize(13)
      .fontColor(this.selectedRuntimeId === runtime.runtimeId ? getColors().onPrimaryAction : getColors().ink)
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .borderRadius(16)
      .backgroundColor(this.selectedRuntimeId === runtime.runtimeId ? getColors().primaryAction : getColors().subtle)
      .margin({ right: 8, bottom: 8 })
      .onClick(() => {
        this.onRuntimeSelected(runtime);
      })
  }

  @Builder
  optionChip(option: NewSessionCatalogOption, onSelected: (id: string) => void) {
    Text(option.label)
      .fontSize(13)
      .fontColor(this.optionChipTextColor(option))
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .borderRadius(16)
      .backgroundColor(this.optionChipColor(option))
      .margin({ right: 8, bottom: 8 })
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .constraintSize({ maxWidth: 220 })
      .onClick(() => {
        if (option.enabled) {
          onSelected(option.id);
        }
      })
  }

  @Builder
  catalogLoadingRow() {
    Row({ space: 8 }) {
      LoadingProgress()
        .width(18)
        .height(18)
      Text($r('app.string.new_session_catalog_loading'))
        .fontSize(13)
        .fontColor(getColors().muted)
    }
    .width('100%')
  }

  @Builder
  catalogErrorRow(message: string) {
    Column({ space: 8 }) {
      Text(message)
        .fontSize(13)
        .fontColor(getColors().errorText)
        .width('100%')
      Button($r('app.string.common_retry'))
        .fontSize(13)
        .height(32)
        .padding({ left: 14, right: 14 })
        .backgroundColor(getColors().subtle)
        .fontColor(getColors().ink)
        .onClick(() => {
          this.onRetryRuntimeDetails();
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  catalogUnavailableRow() {
    Text($r('app.string.new_session_catalog_unavailable'))
      .fontSize(13)
      .fontColor(getColors().faint)
      .width('100%')
  }

  @Builder
  catalogSection() {
    Column({ space: 10 }) {
      this.sectionLabel($r('app.string.new_session_model'))
      if (this.catalog.loading) {
        this.catalogLoadingRow()
      } else if (this.catalog.errorText.length > 0) {
        this.catalogErrorRow(this.catalog.errorText)
      } else if (this.catalog.modelUnavailable || this.catalog.models.length === 0) {
        this.catalogUnavailableRow()
      } else {
        Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
          ForEach(this.catalog.models, (option: NewSessionCatalogOption) => {
            this.optionChip(option, (id: string) => {
              this.onModelSelected(id);
            })
          }, (option: NewSessionCatalogOption) => `${option.id}:${option.selected}`)
        }
        .width('100%')
      }
      if (!this.catalog.loading && this.catalog.errorText.length === 0 &&
        !this.catalog.modelUnavailable && this.catalog.efforts.length > 0) {
        this.sectionLabel($r('app.string.new_session_reasoning'))
        Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
          ForEach(this.catalog.efforts, (option: NewSessionCatalogOption) => {
            this.optionChip(option, (id: string) => {
              this.onEffortSelected(id);
            })
          }, (option: NewSessionCatalogOption) => `${option.id}:${option.selected}`)
        }
        .width('100%')
      }
      this.sectionLabel($r('app.string.new_session_permission'))
      if (this.catalog.loading) {
        this.catalogLoadingRow()
      } else if (this.catalog.errorText.length > 0) {
        this.catalogErrorRow(this.catalog.errorText)
      } else if (this.catalog.permissionUnavailable || this.catalog.permissions.length === 0) {
        this.catalogUnavailableRow()
      } else {
        Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
          ForEach(this.catalog.permissions, (option: NewSessionCatalogOption) => {
            this.optionChip(option, (id: string) => {
              this.onPermissionSelected(id);
            })
          }, (option: NewSessionCatalogOption) => `${option.id}:${option.selected}`)
        }
        .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  attachmentRow(entry: NewSessionPendingAttachment) {
    Row({ space: 8 }) {
      Text(entry.name)
        .fontSize(13)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 160 })
        .layoutWeight(1)
      Text(this.attachmentSizeLabel(entry.size))
        .fontSize(12)
        .fontColor(getColors().faint)
      Text('✕')
        .fontSize(13)
        .fontColor(getColors().faint)
        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
        .onClick(() => {
          this.onRemoveAttachment(entry.localId);
        })
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .borderRadius(12)
    .backgroundColor(getColors().subtle)
  }

  @Builder
  browserEntryRow(entry: NewSessionBrowserEntryView) {
    Row({ space: 8 }) {
      Text('📁')
        .fontSize(14)
      Text(entry.name)
        .fontSize(13)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .borderRadius(10)
    .backgroundColor(getColors().subtle)
    .margin({ bottom: 6 })
    .onClick(() => {
      this.onBrowserEntrySelected(entry.path);
    })
  }

  @Builder
  browserPanel() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text(this.browser.path.length > 0 ? this.browser.path : $r('app.string.files_windows_drives'))
          .fontSize(12)
          .fontColor(getColors().muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Button($r('app.string.files_up'))
          .fontSize(12)
          .height(30)
          .padding({ left: 10, right: 10 })
          .backgroundColor(getColors().subtle)
          .fontColor(getColors().ink)
          .enabled(this.browser.canGoUp)
          .onClick(() => {
            this.onBrowserUp();
          })
      }
      .width('100%')
      if (this.browser.loading) {
        Row({ space: 8 }) {
          LoadingProgress()
            .width(18)
            .height(18)
          Text($r('app.string.new_session_loading_directory'))
            .fontSize(13)
            .fontColor(getColors().muted)
        }
        .width('100%')
      } else if (this.browser.errorText.length > 0) {
        Column({ space: 8 }) {
          Text(this.browser.errorText)
            .fontSize(13)
            .fontColor(getColors().errorText)
            .width('100%')
          Button($r('app.string.common_retry'))
            .fontSize(12)
            .height(30)
            .padding({ left: 12, right: 12 })
            .backgroundColor(getColors().subtle)
            .fontColor(getColors().ink)
            .onClick(() => {
              this.onBrowserRetry();
            })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      } else if (this.browser.entries.length === 0) {
        Text($r('app.string.new_session_empty_directory'))
          .fontSize(13)
          .fontColor(getColors().faint)
          .width('100%')
      } else {
        List() {
          ForEach(this.browser.entries, (entry: NewSessionBrowserEntryView) => {
            ListItem() {
              this.browserEntryRow(entry)
            }
          }, (entry: NewSessionBrowserEntryView) => entry.path)
        }
        .width('100%')
        .constraintSize({ maxHeight: 220 })
        .scrollBar(BarState.Auto)
      }
      Button($r('app.string.new_session_use_directory'))
        .fontSize(13)
        .height(34)
        .padding({ left: 14, right: 14 })
        .backgroundColor(getColors().primaryAction)
        .fontColor(getColors().onPrimaryAction)
        .enabled(!this.browser.loading && this.browser.path.length > 0)
        .onClick(() => {
          this.onUseDirectory();
        })
    }
    .width('100%')
    .padding(10)
    .borderRadius(12)
    .backgroundColor(getColors().subtleSurface)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  setupPanel() {
    Column({ space: 10 }) {
      if (this.setupState === 'checking') {
        LoadingProgress()
          .width(32)
          .height(32)
        Text($r('app.string.new_session_checking_devices'))
          .fontSize(14)
          .fontColor(getColors().muted)
      } else if (this.setupState === 'devices_load_failed') {
        Text($r('app.string.new_session_devices_unavailable'))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .lineHeight(19)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.new_session_devices_unavailable_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
        Button($r('app.string.common_retry'))
        .fontSize(16)
        .fontWeight(600)
        .height(54)
        .borderRadius(18)
        .padding({ left: 16, right: 16 })
        .backgroundColor(getColors().primaryAction)
          .fontColor(getColors().onPrimaryAction)
          .onClick(() => {
            this.onRetrySetup();
          })
      } else if (this.setupState === 'no_devices') {
        Text($r('app.string.new_session_connect_device_title'))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .lineHeight(19)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.new_session_connect_device_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
        Button($r('app.string.new_session_view_devices'))
        .fontSize(16)
        .fontWeight(600)
        .height(54)
        .borderRadius(18)
        .padding({ left: 16, right: 16 })
        .backgroundColor(getColors().primaryAction)
          .fontColor(getColors().onPrimaryAction)
          .onClick(() => {
            this.onViewDevices();
          })
      } else if (this.setupState === 'devices_offline') {
        Text($r('app.string.new_session_devices_offline_title'))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .lineHeight(19)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.new_session_devices_offline_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
        Button($r('app.string.new_session_check_again'))
        .fontSize(16)
        .fontWeight(600)
        .height(54)
        .borderRadius(18)
        .padding({ left: 16, right: 16 })
        .backgroundColor(getColors().primaryAction)
          .fontColor(getColors().onPrimaryAction)
          .onClick(() => {
            this.onRetrySetup();
          })
      } else if (this.setupState === 'no_runtimes') {
        Text($r('app.string.new_session_setup_agent_title'))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .lineHeight(19)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.new_session_setup_agent_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
        Button($r('app.string.new_session_check_again'))
        .fontSize(16)
        .fontWeight(600)
        .height(54)
        .borderRadius(18)
        .padding({ left: 16, right: 16 })
        .backgroundColor(getColors().primaryAction)
          .fontColor(getColors().onPrimaryAction)
          .onClick(() => {
            this.onRetrySetup();
          })
      } else if (this.setupState === 'runtimes_load_failed') {
        Text($r('app.string.new_session_agents_unavailable'))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .lineHeight(19)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.new_session_agents_unavailable_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
        Button($r('app.string.common_retry'))
        .fontSize(16)
        .fontWeight(600)
        .height(54)
        .borderRadius(18)
        .padding({ left: 16, right: 16 })
        .backgroundColor(getColors().primaryAction)
          .fontColor(getColors().onPrimaryAction)
          .onClick(() => {
            this.onRetrySetup();
          })
      }
    }
    .width('100%')
    .padding({ top: 16, bottom: 16 })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.themeIsDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.4)')
      .onClick(() => {
        this.onClose();
      })
      Column({ space: 12 }) {
        if (this.setupState === 'ready') {
          TextInput({ text: this.titleInput, placeholder: $r('app.string.home_session_title_placeholder') })
            .fontSize(20)
            .fontWeight(600)
            .lineHeight(24)
            .height(42)
            .width('100%')
            .enabled(!this.creating)
            .onChange((value: string) => {
              this.onTitleChange(value);
            })
          Scroll() {
            Column({ space: 12 }) {
              Column({ space: 6 }) {
                this.sectionLabel($r('app.string.new_session_device'))
                if (this.devices.length === 0) {
                  Text($r('app.string.new_session_no_device'))
                    .fontSize(13)
                    .fontColor(getColors().faint)
                    .width('100%')
                } else {
                  Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
                    ForEach(this.devices, (device: RemoteDevice) => {
                      this.deviceChip(device)
                    }, (device: RemoteDevice) => device.id)
                  }
                  .width('100%')
                }
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              Column({ space: 6 }) {
                this.sectionLabel($r('app.string.new_session_agent'))
                if (this.runtimesLoading) {
                  LoadingProgress()
                    .width(22)
                    .height(22)
                } else if (this.runtimes.length === 0) {
                  Text($r('app.string.new_session_no_attached_agents'))
                    .fontSize(13)
                    .fontColor(getColors().faint)
                    .width('100%')
                } else {
                  Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
                    ForEach(this.runtimes, (runtime: RemoteDeviceRuntime) => {
                      this.runtimeChip(runtime)
                    }, (runtime: RemoteDeviceRuntime) => `${runtime.runtimeId}:${runtime.runtimeType}`)
                  }
                  .width('100%')
                }
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              if (this.selectedRuntimeId.length > 0) {
                this.catalogSection()
              }
              Column({ space: 6 }) {
                this.sectionLabel($r('app.string.new_session_workspace'))
                Row({ space: 8 }) {
                  TextInput({ text: this.cwdInput, placeholder: '~' })
                    .fontSize(14)
                    .height(40)
                    .layoutWeight(1)
                    .enabled(!this.creating)
                    .onChange((value: string) => {
                      this.onCwdChange(value);
                    })
                  Button($r('app.string.new_session_choose_directory'))
                    .fontSize(12)
                    .height(40)
                    .padding({ left: 12, right: 12 })
                    .backgroundColor(getColors().subtle)
                    .fontColor(getColors().ink)
                    .enabled(!this.creating)
                    .onClick(() => {
                      this.onChooseDirectory();
                    })
                }
                .width('100%')
                .alignItems(VerticalAlign.Center)
                if (this.browser.visible) {
                  this.browserPanel()
                }
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              Column({ space: 6 }) {
                this.sectionLabel($r('app.string.new_session_first_message'))
                TextArea({ text: this.messageInput, placeholder: $r('app.string.new_session_message_placeholder') })
                  .fontSize(14)
                  .constraintSize({ minHeight: 72 })
                  .width('100%')
                  .enabled(!this.creating)
                  .onChange((value: string) => {
                    this.onMessageChange(value);
                  })
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              Column({ space: 8 }) {
                this.sectionLabel($r('app.string.new_session_attach_files'))
                Row({ space: 8 }) {
                  Button($r('app.string.new_session_pick_photos'))
                    .fontSize(13)
                    .height(36)
                    .padding({ left: 14, right: 14 })
                    .backgroundColor(getColors().subtle)
                    .fontColor(getColors().ink)
                    .enabled(!this.creating && !this.pickingAttachment)
                    .onClick(() => {
                      this.onPickPhotos();
                    })
                  Button($r('app.string.new_session_pick_files'))
                    .fontSize(13)
                    .height(36)
                    .padding({ left: 14, right: 14 })
                    .backgroundColor(getColors().subtle)
                    .fontColor(getColors().ink)
                    .enabled(!this.creating && !this.pickingAttachment)
                    .onClick(() => {
                      this.onPickFiles();
                    })
                }
                .width('100%')
                .alignItems(VerticalAlign.Center)
                ForEach(this.attachments, (entry: NewSessionPendingAttachment) => {
                  this.attachmentRow(entry)
                }, (entry: NewSessionPendingAttachment) => entry.localId)
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              if (this.errorText.length > 0) {
                Text(this.errorText)
                  .fontSize(13)
                  .fontColor(getColors().errorText)
                  .width('100%')
              }
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.Top)
          .edgeEffect(EdgeEffect.Spring)
          Row({ space: 10 }) {
            Button($r('app.string.common_cancel'))
              .fontSize(16)
              .fontWeight(600)
              .fontColor(getColors().ink)
              .backgroundColor(getColors().subtle)
              .height(54)
              .borderRadius(18)
              .layoutWeight(1)
              .enabled(!this.creating)
              .onClick(() => {
                this.onClose();
              })
            Button(this.startButtonLabel())
              .fontSize(16)
              .fontWeight(600)
              .fontColor(getColors().onPrimaryAction)
              .backgroundColor(getColors().primaryAction)
              .height(54)
              .borderRadius(18)
              .layoutWeight(1)
              .enabled(this.startEnabled && !this.creating)
              .onClick(() => {
                this.onCreate();
              })
          }
          .width('100%')
        } else {
          Row({ space: 8 }) {
            Text($r('app.string.new_session_title'))
              .fontSize(20)
              .fontWeight(800)
              .lineHeight(24)
              .fontColor(getColors().ink)
              .layoutWeight(1)
            Text('✕')
              .fontSize(16)
              .fontColor(getColors().muted)
              .padding({ left: 8, right: 8, top: 2, bottom: 2 })
              .onClick(() => {
                this.onClose();
              })
          }
          .width('100%')
          Scroll() {
            this.setupPanel()
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.Top)
        }
      }
      .width('100%')
      .constraintSize({ maxHeight: '82%' })
      .padding({ left: 18, right: 18, top: 16, bottom: 20 })
      .borderRadius({ topLeft: 20, topRight: 20 })
      .backgroundColor(getColors().dialogSurface)
    }
    .width('100%')
    .height('100%')
  }
}
