import { ApiClient } from 'network';
import { SharedApiClient } from '../api/SharedApiClient';
import { DevicesApi, RemoteDevice } from 'network';
import { FilesApi, RemoteDirectoryEntry } from 'network';
import { SessionsApi } from 'network';
import { RemoteProject } from 'network';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import { ApiException, errorMessageFrom } from 'common';
import { availableProjectName, workspaceProject, workspaceProjectName } from '../common/WorkspaceProjects';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorState, LoadingState } from '../components/StateViews';
import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct NewProjectPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State devicesLoading: boolean = true;
  @State devicesError: string = '';
  @State devices: RemoteDevice[] = [];
  @State selectedDeviceId: string = '';
  @State currentPath: string = '~';
  @State entries: RemoteDirectoryEntry[] = [];
  @State pathLoading: boolean = false;
  @State pathError: string = '';
  @State nameInput: string = '';
  @State creating: boolean = false;
  @State createError: string = '';
  private navPathStack: NavPathStack = new NavPathStack();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private filesApi: FilesApi = new FilesApi(this.client);
  private sessionsApi: SessionsApi = new SessionsApi(this.client);
  private directoryRequestSeq: number = 0;
  private nameEdited: boolean = false;
  private selectedWorkspacePath: string = '';
  private conflictProject: RemoteProject | null = null;
  private conflictDialog: CustomDialogController = new CustomDialogController({
    builder: ConfirmDialog({
      title: $r('app.string.project_workspace_conflict_title'),
      message: $r('app.string.project_workspace_conflict_message',
        this.conflictProject === null ? '' : this.conflictProject.name, this.nameInput),
      confirmText: $r('app.string.project_rename_existing'),
      cancelText: $r('app.string.common_cancel'),
      confirmIsDanger: false,
      onConfirm: (): void => {
        this.conflictDialog.close();
        this.conflictProject = null;
        this.createProject(true);
      },
      onCancel: (): void => {
        this.conflictDialog.close();
        this.conflictProject = null;
      }
    }),
    autoCancel: true,
    alignment: DialogAlignment.Center
  });

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private localText(resource: Resource): string {
    return getContext(this).resourceManager.getStringSync(resource);
  }

  private selectedDevice(): RemoteDevice | null {
    for (const device of this.devices) {
      if (device.id === this.selectedDeviceId) {
        return device;
      }
    }
    return null;
  }

  private containsDevice(devices: RemoteDevice[], deviceId: string): boolean {
    for (const device of devices) {
      if (device.id === deviceId) {
        return true;
      }
    }
    return false;
  }

  private async loadDevices(): Promise<void> {
    this.devicesLoading = true;
    this.devicesError = '';
    try {
      const list = await this.devicesApi.listDevices(this.serverUrl(), this.token());
      const online: RemoteDevice[] = [];
      for (const device of list) {
        if (device.status === 'online') {
          online.push(device);
        }
      }
      this.devices = online;
      if (online.length > 0 &&
        (this.selectedDeviceId.length === 0 || !this.containsDevice(online, this.selectedDeviceId))) {
        this.selectDevice(online[0].id);
      }
    } catch (error) {
      this.devicesError = errorMessageFrom(error as Object);
    }
    this.devicesLoading = false;
  }

  private selectDevice(deviceId: string): void {
    if (this.selectedDeviceId === deviceId && this.entries.length > 0) {
      return;
    }
    this.selectedDeviceId = deviceId;
    this.currentPath = '~';
    this.selectedWorkspacePath = '';
    this.entries = [];
    this.pathError = '';
    this.nameInput = '';
    this.nameEdited = false;
    this.createError = '';
    this.loadDirectory('.', true);
  }

  private async loadDirectory(path: string, select: boolean): Promise<void> {
    const device = this.selectedDevice();
    if (device === null || this.creating) {
      return;
    }
    this.directoryRequestSeq++;
    const seq = this.directoryRequestSeq;
    this.pathLoading = true;
    this.pathError = '';
    try {
      const directory = await this.filesApi.listFiles(this.serverUrl(), this.token(), device.id, '~', path);
      if (seq !== this.directoryRequestSeq) {
        return;
      }
      const directories: RemoteDirectoryEntry[] = [];
      for (const entry of directory.entries) {
        if (entry.type === 'directory') {
          directories.push(entry);
        }
      }
      directories.sort((left: RemoteDirectoryEntry, right: RemoteDirectoryEntry): number => {
        return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      });
      this.entries = directories;
      this.currentPath = directory.path.length > 0 ? directory.path : path;
      if (select) {
        this.selectedWorkspacePath = this.currentPath;
        if (!this.nameEdited) {
          this.nameInput = workspaceProjectName(this.currentPath);
        }
      }
    } catch (error) {
      if (seq !== this.directoryRequestSeq) {
        return;
      }
      this.entries = [];
      this.pathError = this.localText($r('app.string.new_session_load_directory_failed'));
    }
    if (seq === this.directoryRequestSeq) {
      this.pathLoading = false;
    }
  }

  private parentPath(): string {
    const path = this.currentPath;
    const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (slashIndex < 0) {
      return '.';
    }
    const parent = path.substring(0, slashIndex);
    if (parent.length === 0) {
      return '/';
    }
    return parent;
  }

  private canGoUp(): boolean {
    const path = this.currentPath;
    return path.length > 0 && path !== '.' && path !== '/' && path !== '~';
  }

  private goUp(): void {
    if (!this.canGoUp() || this.creating) {
      return;
    }
    this.loadDirectory(this.parentPath(), true);
  }

  private retryLoadDirectory(): void {
    if (this.creating) {
      return;
    }
    const path = this.currentPath.length === 0 || this.currentPath === '~' ? '.' : this.currentPath;
    this.loadDirectory(path, true);
  }

  private openEntry(entry: RemoteDirectoryEntry): void {
    if (this.creating) {
      return;
    }
    this.loadDirectory(entry.path, true);
  }

  private canCreate(): boolean {
    return !this.creating && this.nameInput.trim().length > 0 && this.selectedWorkspacePath.trim().length > 0 &&
      this.pathError.length === 0 && !this.pathLoading;
  }

  private async createProject(confirmRename: boolean): Promise<void> {
    const device = this.selectedDevice();
    if (device === null || this.creating || !this.canCreate()) {
      return;
    }
    const inputPath = this.selectedWorkspacePath.trim();
    const inputName = this.nameInput.trim();
    const useDirectoryName = !this.nameEdited;
    this.creating = true;
    this.createError = '';
    let attemptedName = inputName;
    try {
      let path = inputPath;
      if (path.startsWith('~')) {
        const directory = await this.filesApi.listFiles(this.serverUrl(), this.token(), device.id, path, '.');
        const resolved = directory.path;
        if (resolved.length === 0 || resolved.startsWith('~')) {
          throw new Error(this.localText($r('app.string.workspace_resolve_failed')));
        }
        path = resolved;
      }
      const latestResponse = await this.sessionsApi.listProjects(this.serverUrl(), this.token());
      const latest = latestResponse.projects;
      const existing = workspaceProject(latest, device.id, path, device.deviceOs);
      attemptedName = availableProjectName(
        useDirectoryName
          ? (existing !== null ? existing.name : workspaceProjectName(path))
          : inputName,
        latest);
      this.selectedWorkspacePath = path;
      this.nameInput = attemptedName;
      if (!confirmRename && existing !== null && existing.name !== attemptedName) {
        this.conflictProject = existing;
        this.conflictDialog.open();
        return;
      }
      await this.sessionsApi.createProject(this.serverUrl(), this.token(), attemptedName, device.id, path, true);
      const tick = AppStorage.get<number>('homeRefreshTick');
      AppStorage.setOrCreate<number>('homeRefreshTick', (tick === undefined ? 0 : tick) + 1);
      this.navPathStack.pop();
    } catch (error) {
      if (error instanceof ApiException && error.errorCode === 'project_name_conflict') {
        let latest: RemoteProject[] = [];
        try {
          const response = await this.sessionsApi.listProjects(this.serverUrl(), this.token());
          latest = response.projects;
        } catch (ignored) {
        }
        this.nameInput = availableProjectName(attemptedName, latest);
        this.nameEdited = true;
        this.createError = this.localText($r('app.string.project_name_adjusted'));
      } else {
        this.createError = errorMessageFrom(error as Object);
      }
    } finally {
      this.creating = false;
    }
  }

  @Builder
  fieldLabel(label: ResourceStr) {
    Text(label)
      .fontSize(13)
      .fontWeight(FontWeight.Bold)
      .fontColor(getColors().inkSoft)
      .width('100%')
  }

  @Builder
  deviceRow(device: RemoteDevice) {
    Row({ space: 10 }) {
      SymbolGlyph($r('sys.symbol.pc'))
        .fontSize(18)
        .fontColor([getColors().faint])
      Text(device.name)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (device.id === this.selectedDeviceId) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(16)
          .fontColor([getColors().primaryAction])
      }
    }
    .width('100%')
    .height(48)
    .padding({ left: 14, right: 14 })
    .borderRadius(12)
    .backgroundColor(getColors().raisedSurface)
    .border({
      width: 1,
      color: device.id === this.selectedDeviceId ? getColors().primaryAction : getColors().border
    })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (!this.creating) {
        this.selectDevice(device.id);
      }
    })
  }

  @Builder
  directoryEntryRow(entry: RemoteDirectoryEntry) {
    Row({ space: 10 }) {
      SymbolGlyph($r('sys.symbol.folder'))
        .fontSize(16)
        .fontColor([getColors().faint])
      Text(entry.name)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().inkSoft)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .height(40)
    .padding({ left: 4, right: 4 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.openEntry(entry);
    })
  }

  build() {
    NavDestination() {
      Column() {
        if (this.devicesLoading) {
          Column() {
            LoadingState()
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.devicesError.length > 0) {
          Column() {
            ErrorState({
              message: this.devicesError,
              onRetry: (): void => {
                this.loadDevices();
              }
            })
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.devices.length === 0) {
          Column({ space: 12 }) {
            Text($r('app.string.new_session_connect_device_title'))
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor(getColors().ink)
              .textAlign(TextAlign.Center)
            Text($r('app.string.new_session_devices_offline_description'))
              .fontSize(14)
              .lineHeight(20)
              .fontColor(getColors().muted)
              .textAlign(TextAlign.Center)
              .constraintSize({ maxWidth: 294 })
            Row() {
              Text($r('app.string.home_pair_new_device'))
                .fontSize(14)
                .fontWeight(FontWeight.Bold)
                .fontColor(getColors().onPrimaryAction)
            }
            .height(44)
            .padding({ left: 18, right: 18 })
            .borderRadius(22)
            .backgroundColor(getColors().primaryAction)
            .margin({ top: 8 })
            .onClick(() => {
              this.navPathStack.pushPathByName('pairing', '');
            })
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
        } else {
          Column({ space: 10 }) {
            this.fieldLabel($r('app.string.home_project_device'))
            ForEach(this.devices, (device: RemoteDevice) => {
              this.deviceRow(device)
            }, (device: RemoteDevice) => device.id)
            this.fieldLabel($r('app.string.home_project_name'))
            TextInput({ text: this.nameInput })
              .height(50)
              .borderRadius(12)
              .backgroundColor(this.themeIsDark ? '#111113' : '#F7F7F5')
              .border({ width: 1, color: getColors().border })
              .padding({ left: 14, right: 14 })
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(getColors().ink)
              .caretColor(getColors().ink)
              .maxLength(255)
              .enabled(!this.creating)
              .onChange((value: string) => {
                this.nameEdited = true;
                this.nameInput = value;
                this.createError = '';
              })
            this.fieldLabel($r('app.string.new_session_project_directory'))
            Column() {
              Row({ space: 10 }) {
                Text(this.currentPath)
                  .fontSize(13)
                  .fontFamily('monospace')
                  .fontColor(getColors().inkSoft)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                if (this.canGoUp()) {
                  SymbolGlyph($r('sys.symbol.chevron_up'))
                    .fontSize(16)
                    .fontColor([getColors().inkSoft])
                    .width(32)
                    .height(32)
                    .onClick(() => {
                      this.goUp();
                    })
                }
              }
              .width('100%')
              .height(36)
              .alignItems(VerticalAlign.Center)
              if (this.pathLoading) {
                Row() {
                  LoadingProgress()
                    .width(18)
                    .height(18)
                    .color(getColors().muted)
                }
                .width('100%')
                .layoutWeight(1)
                .justifyContent(FlexAlign.Center)
              } else if (this.pathError.length > 0) {
                Column({ space: 10 }) {
                  Text(this.pathError)
                    .fontSize(13)
                    .fontColor(getColors().errorText)
                    .textAlign(TextAlign.Center)
                  Text($r('app.string.common_retry'))
                    .fontSize(14)
                    .fontWeight(FontWeight.Bold)
                    .fontColor(getColors().primaryAction)
                    .onClick(() => {
                      this.retryLoadDirectory();
                    })
                }
                .width('100%')
                .layoutWeight(1)
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center)
              } else {
                List({ space: 0 }) {
                  ForEach(this.entries, (entry: RemoteDirectoryEntry) => {
                    ListItem() {
                      this.directoryEntryRow(entry)
                    }
                  }, (entry: RemoteDirectoryEntry) => entry.path)
                }
                .width('100%')
                .layoutWeight(1)
                .scrollBar(BarState.Off)
              }
              if (this.selectedWorkspacePath.length > 0) {
                Row({ space: 6 }) {
                  SymbolGlyph($r('sys.symbol.checkmark'))
                    .fontSize(13)
                    .fontColor([getColors().primaryAction])
                  Text(this.selectedWorkspacePath)
                    .fontSize(12)
                    .fontFamily('monospace')
                    .fontColor(getColors().faint)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                }
                .width('100%')
                .height(24)
                .alignItems(VerticalAlign.Center)
              }
            }
            .width('100%')
            .layoutWeight(1)
            .padding(14)
            .borderRadius(14)
            .backgroundColor(getColors().raisedSurface)
            .border({ width: 1, color: getColors().border })
            .alignItems(HorizontalAlign.Start)
            if (this.createError.length > 0) {
              Text(this.createError)
                .fontSize(13)
                .fontWeight(600)
                .fontColor(getColors().errorText)
                .width('100%')
            }
            Row() {
              Text($r('app.string.new_session_create_project'))
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .fontColor(getColors().onPrimaryAction)
            }
            .width('100%')
            .height(50)
            .justifyContent(FlexAlign.Center)
            .borderRadius(16)
            .backgroundColor(getColors().primaryAction)
            .opacity(this.canCreate() ? 1 : 0.38)
            .onClick(() => {
              this.createProject(false);
            })
          }
          .width('100%')
          .height('100%')
          .alignItems(HorizontalAlign.Start)
        }
      }
      .width('100%')
      .height('100%')
      .padding({ left: 22, right: 22, top: 12, bottom: 24 })
    }
    .title($r('app.string.new_session_create_project'))
    .onReady((context: NavDestinationContext) => {
      this.navPathStack = context.pathStack;
      this.loadDevices();
    })
  }
}

@Builder
export function NewProjectPageBuilder() {
  NewProjectPage()
}
