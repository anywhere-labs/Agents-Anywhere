import { pasteboard } from '@kit.BasicServicesKit';
import { ApiClient } from 'network';
import { DevicesApi, RemoteDevice } from 'network';
import { FilesApi, RemoteDirectoryEntry, RemoteTextFile } from 'network';
import { SharedApiClient } from 'session';
import { AuthSessionStore } from 'session';
import { errorMessageFrom } from 'common';
import {
  FilePreviewLine,
  FilePreviewLineDataSource,
  fileContentLines,
  fileEntryKind,
  fileEntrySymbol,
  findMatchLineIndexes,
  initialRemoteFilePath,
  isHiddenFileEntryName,
  isWindowsDeviceOs,
  isWindowsDriveRootPath,
  isWindowsDriveStylePath,
  windowsDriveRootOf,
  windowsParentPath
} from 'common';
import { FileRowMenuOverlay } from '../components/FileRowMenuOverlay';
import { HomeMenuAnchor } from 'session';
import { EmptyState } from 'session';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { showToast } from 'common';

const HOME_ROOT = '~';
const START_PATH = '.';

function parentPath(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slashIndex < 0) {
    return START_PATH;
  }
  const parent = path.substring(0, slashIndex);
  if (parent.length === 0) {
    return '/';
  }
  return parent;
}

function canGoUp(path: string): boolean {
  return path !== START_PATH && path !== '/' && path.length > 0;
}

function formatSize(size: number | null): string {
  if (size === null) {
    return '';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1048576) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1048576).toFixed(1)} MB`;
}

@Component
export struct FilesPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State loading: boolean = true;
  @State errorMessage: string = '';
  @State deviceId: string = '';
  @State devices: RemoteDevice[] = [];
  @State devicesEmpty: boolean = false;
  @State selectedDeviceOffline: boolean = false;
  @State entries: RemoteDirectoryEntry[] = [];
  @State currentPath: string = START_PATH;
  @State viewingFile: boolean = false;
  @State loadingFile: boolean = false;
  @State fileName: string = '';
  @State fileContent: string = '';
  @State fileSizeLabel: string = '';
  @State fileTruncated: boolean = false;
  @State fileBinary: boolean = false;
  @State searchOpen: boolean = false;
  @State searchQuery: string = '';
  @State searchTotal: number = 0;
  @State searchCurrentOrdinal: number = 0;
  @State copiedContent: boolean = false;
  @State rowMenuOpen: boolean = false;
  @State rowMenuEntryName: string = '';
  @State pickerOpen: boolean = false;
  @State pickerAnchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @State pickerWidth: number = 286;
  @State pressedRowPath: string = '';
  @State pathCopied: boolean = false;
  private rowMenuEntryPath: string = '';
  private resolvedRoot: string = HOME_ROOT;
  private searchMatchLines: number[] = [];
  private searchCurrentIndex: number = 0;
  private copiedContentTimer: number = -1;
  private pathCopiedTimer: number = -1;
  private rawLines: string[] = [];
  private previewLines: FilePreviewLineDataSource = new FilePreviewLineDataSource();
  private navPathStack: NavPathStack = new NavPathStack();
  private scroller: Scroller = new Scroller();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private filesApi: FilesApi = new FilesApi(this.client);

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private localizedText(resource: Resource): string {
    try {
      const context = this.getUIContext().getHostContext();
      if (context !== undefined) {
        return context.resourceManager.getStringSync(resource);
      }
    } catch (error) {
    }
    return '';
  }

  private async pickDevice(): Promise<void> {
    const devices = await this.devicesApi.listDevices(this.serverUrl(), this.token());
    if (devices.length === 0) {
      this.devices = [];
      this.devicesEmpty = true;
      this.selectedDeviceOffline = false;
      this.loading = false;
      return;
    }
    let selectedIndex = -1;
    for (let index = 0; index < devices.length; index++) {
      if (devices[index].id === this.deviceId && devices[index].status === 'online') {
        selectedIndex = index;
        break;
      }
    }
    if (selectedIndex < 0) {
      for (let index = 0; index < devices.length; index++) {
        if (devices[index].status === 'online') {
          selectedIndex = index;
          break;
        }
      }
    }
    if (selectedIndex < 0) {
      selectedIndex = 0;
    }
    this.devices = devices;
    this.deviceId = devices[selectedIndex].id;
    this.devicesEmpty = false;
    this.selectedDeviceOffline = devices[selectedIndex].status !== 'online';
  }

  private hasOnlineDevice(): boolean {
    for (const device of this.devices) {
      if (device.status === 'online') {
        return true;
      }
    }
    return false;
  }

  private selectedOnlineDevice(): RemoteDevice | null {
    for (const device of this.devices) {
      if (device.id === this.deviceId && device.status === 'online') {
        return device;
      }
    }
    return null;
  }

  private triggerDeviceName(): string {
    const device = this.selectedOnlineDevice();
    if (device === null) {
      return this.localizedText($r('app.string.devices_no_online'));
    }
    return device.name;
  }

  private sortEntries(entries: RemoteDirectoryEntry[]): RemoteDirectoryEntry[] {
    const sorted = entries.slice(0);
    sorted.sort((left: RemoteDirectoryEntry, right: RemoteDirectoryEntry): number => {
      const leftDir = left.type === 'directory';
      const rightDir = right.type === 'directory';
      if (leftDir !== rightDir) {
        return leftDir ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    return sorted;
  }

  private selectedDeviceIsWindows(): boolean {
    for (const device of this.devices) {
      if (device.id === this.deviceId) {
        return isWindowsDeviceOs(device.deviceOs);
      }
    }
    return false;
  }

  private filterHiddenEntries(source: RemoteDirectoryEntry[]): RemoteDirectoryEntry[] {
    const windowsDevice = this.selectedDeviceIsWindows();
    const visible: RemoteDirectoryEntry[] = [];
    for (const entry of source) {
      if (!isHiddenFileEntryName(entry.name, windowsDevice)) {
        visible.push(entry);
      }
    }
    return visible;
  }

  private async loadDirectory(path: string): Promise<void> {
    if (this.deviceId.length === 0) {
      return;
    }
    let requestPath = path;
    let requestRoot = this.resolvedRoot;
    if (isWindowsDriveStylePath(requestPath)) {
      if (requestPath.length === 2) {
        requestPath = `${requestPath}\\`;
      }
      requestRoot = windowsDriveRootOf(requestPath);
    }
    try {
      const directory = await this.filesApi.listFiles(this.serverUrl(), this.token(), this.deviceId,
        requestRoot, requestPath);
      this.entries = this.sortEntries(this.filterHiddenEntries(directory.entries));
      this.currentPath = directory.path.length > 0 ? directory.path : requestPath;
      if (isWindowsDriveStylePath(this.currentPath)) {
        this.resolvedRoot = windowsDriveRootOf(this.currentPath);
      } else if (requestRoot === HOME_ROOT && this.currentPath.length > 0) {
        this.resolvedRoot = this.currentPath;
      }
      this.errorMessage = '';
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.loading = false;
  }

  private async start(): Promise<void> {
    try {
      await this.pickDevice();
      const device = this.selectedOnlineDevice();
      if (this.deviceId.length > 0 && !this.selectedDeviceOffline && device !== null) {
        await this.loadDirectory(initialRemoteFilePath(device.deviceOs));
      }
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
      this.loading = false;
    }
  }

  private handleDeviceChange(device: RemoteDevice): void {
    this.pickerOpen = false;
    this.deviceId = device.id;
    this.selectedDeviceOffline = device.status !== 'online';
    this.entries = [];
    this.currentPath = initialRemoteFilePath(device.deviceOs);
    this.resolvedRoot = HOME_ROOT;
    this.viewingFile = false;
    this.errorMessage = '';
    this.loading = true;
    this.loadDirectory(initialRemoteFilePath(device.deviceOs));
  }

  private openEntry(entry: RemoteDirectoryEntry): void {
    if (entry.type === 'directory') {
      this.loadDirectory(entry.path);
      return;
    }
    if (entry.type === 'file') {
      this.openTextFile(entry);
    }
  }

  private async openTextFile(entry: RemoteDirectoryEntry): Promise<void> {
    this.loadingFile = true;
    this.errorMessage = '';
    try {
      const file: RemoteTextFile = await this.filesApi.readTextFile(this.serverUrl(), this.token(),
        this.deviceId, this.resolvedRoot, entry.path);
      this.fileName = file.name;
      this.fileContent = file.content;
      this.fileSizeLabel = formatSize(file.size);
      this.fileTruncated = file.truncated;
      this.fileBinary = file.binary;
      this.resetSearch();
      this.rawLines = fileContentLines(file.content);
      this.rebuildPreviewLines();
      this.viewingFile = true;
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.loadingFile = false;
  }

  private goUp(): void {
    if (!canGoUp(this.currentPath)) {
      return;
    }
    if (isWindowsDriveRootPath(this.currentPath)) {
      this.loadDirectory('');
      return;
    }
    if (isWindowsDriveStylePath(this.currentPath)) {
      this.loadDirectory(windowsParentPath(this.currentPath));
      return;
    }
    this.loadDirectory(parentPath(this.currentPath));
  }

  private closeViewer(): void {
    this.viewingFile = false;
    this.fileName = '';
    this.fileContent = '';
    this.fileTruncated = false;
    this.fileBinary = false;
    this.resetSearch();
  }

  private entrySymbol(entry: RemoteDirectoryEntry): Resource {
    return fileEntrySymbol(fileEntryKind(entry.name, entry.type === 'directory'));
  }

  private displayedPathText(): string {
    if (this.currentPath.length === 0) {
      return this.localizedText($r('app.string.files_windows_drives'));
    }
    return this.currentPath.replace(/\\/g, '/');
  }

  private listMessageText(): string {
    if (this.loading) {
      return this.localizedText($r('app.string.files_loading'));
    }
    if (this.errorMessage.length > 0) {
      return this.errorMessage;
    }
    return this.localizedText($r('app.string.files_empty_directory'));
  }

  private openPairing(): void {
    this.navPathStack.pushPathByName('devices', '');
  }

  private openPicker(): void {
    if (!this.hasOnlineDevice() || this.pickerOpen) {
      return;
    }
    try {
      const uiContext = this.getUIContext();
      const utils = uiContext.getComponentUtils();
      const rootRect = utils.getRectangleById('files_anchor_origin');
      const rect = utils.getRectangleById('files_device_selector');
      const anchor: HomeMenuAnchor = {
        x: uiContext.px2vp(rect.windowOffset.x - rootRect.windowOffset.x),
        y: uiContext.px2vp(rect.windowOffset.y - rootRect.windowOffset.y),
        width: uiContext.px2vp(rect.size.width),
        height: uiContext.px2vp(rect.size.height)
      };
      this.pickerAnchor = anchor;
      this.pickerWidth = Math.min(286, anchor.width);
      this.pickerOpen = true;
    } catch (error) {
    }
  }

  // --- In-file search ---

  private resetSearch(): void {
    this.searchOpen = false;
    this.searchQuery = '';
    this.searchMatchLines = [];
    this.searchCurrentIndex = 0;
    this.searchTotal = 0;
    this.searchCurrentOrdinal = 0;
  }

  private currentMatchLine(): number {
    if (this.searchCurrentIndex < this.searchMatchLines.length) {
      return this.searchMatchLines[this.searchCurrentIndex];
    }
    return -1;
  }

  private rebuildPreviewLines(): void {
    const lines: FilePreviewLine[] = [];
    const matchLines = this.searchMatchLines;
    const currentLine = this.currentMatchLine();
    let matchPointer = 0;
    for (let i = 0; i < this.rawLines.length; i++) {
      const line = new FilePreviewLine();
      line.text = this.rawLines[i];
      line.lineIndex = i;
      while (matchPointer < matchLines.length && matchLines[matchPointer] < i) {
        matchPointer++;
      }
      line.isMatch = matchPointer < matchLines.length && matchLines[matchPointer] === i;
      line.isCurrent = line.isMatch && i === currentLine;
      lines.push(line);
    }
    this.previewLines.reload(lines);
  }

  private applySearch(): void {
    this.searchMatchLines = findMatchLineIndexes(this.rawLines, this.searchQuery);
    this.searchTotal = this.searchMatchLines.length;
    if (this.searchMatchLines.length === 0) {
      this.searchCurrentIndex = 0;
      this.searchCurrentOrdinal = 0;
    } else {
      if (this.searchCurrentIndex >= this.searchMatchLines.length) {
        this.searchCurrentIndex = 0;
      }
      this.searchCurrentOrdinal = this.searchCurrentIndex + 1;
    }
    this.rebuildPreviewLines();
    this.scrollToCurrentMatch();
  }

  private toggleSearch(): void {
    if (this.searchOpen) {
      this.searchMatchLines = [];
      this.searchCurrentIndex = 0;
      this.searchTotal = 0;
      this.searchCurrentOrdinal = 0;
      this.searchOpen = false;
      this.rebuildPreviewLines();
      return;
    }
    this.searchOpen = true;
    this.searchCurrentIndex = 0;
    this.applySearch();
  }

  private stepSearch(delta: number): void {
    if (this.searchMatchLines.length === 0) {
      return;
    }
    const previousLine = this.currentMatchLine();
    this.searchCurrentIndex = (this.searchCurrentIndex + delta + this.searchMatchLines.length)
      % this.searchMatchLines.length;
    this.searchCurrentOrdinal = this.searchCurrentIndex + 1;
    const nextLine = this.currentMatchLine();
    if (previousLine !== nextLine) {
      this.previewLines.setCurrent(previousLine, nextLine);
    }
    this.scrollToCurrentMatch();
  }

  private scrollToCurrentMatch(): void {
    const line = this.currentMatchLine();
    if (line >= 0) {
      this.scroller.scrollToIndex(line, true);
    }
  }

  // --- Clipboard ---

  private copyFileContent(): void {
    try {
      const board = pasteboard.getSystemPasteboard();
      const data = pasteboard.createPlainTextData(this.fileContent);
      board.setDataSync(data);
      this.copiedContent = true;
      if (this.copiedContentTimer >= 0) {
        clearTimeout(this.copiedContentTimer);
      }
      this.copiedContentTimer = setTimeout(() => {
        this.copiedContentTimer = -1;
        this.copiedContent = false;
      }, 2000);
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
    }
  }

  private copyPathToClipboard(): void {
    try {
      const board = pasteboard.getSystemPasteboard();
      const data = pasteboard.createPlainTextData(this.displayedPathText());
      board.setDataSync(data);
      this.pathCopied = true;
      if (this.pathCopiedTimer >= 0) {
        clearTimeout(this.pathCopiedTimer);
      }
      this.pathCopiedTimer = setTimeout(() => {
        this.pathCopiedTimer = -1;
        this.pathCopied = false;
      }, 1100);
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
    }
  }

  private copyEntryPath(path: string): void {
    this.closeRowMenu();
    try {
      const board = pasteboard.getSystemPasteboard();
      const data = pasteboard.createPlainTextData(path);
      board.setDataSync(data);
      showToast($r('app.string.files_copied_path'));
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
    }
  }

  // --- Long-press row menu ---

  private openRowMenu(entry: RemoteDirectoryEntry): void {
    this.rowMenuEntryName = entry.name;
    this.rowMenuEntryPath = entry.path;
    this.rowMenuOpen = true;
  }

  private closeRowMenu(): void {
    this.rowMenuOpen = false;
    this.rowMenuEntryName = '';
    this.rowMenuEntryPath = '';
  }

  private viewerNotice(): string {
    if (this.fileBinary) {
      return 'Binary file — preview may be unreadable.';
    }
    return 'File is truncated — showing the first part only.';
  }

  private viewerShowNotice(): boolean {
    return this.fileBinary || this.fileTruncated;
  }

  // --- Colors ---

  private headerIconColor(): string {
    return this.themeIsDark ? '#E4E4E7' : '#1C1C1E';
  }

  private headerBorderColor(): string {
    return this.themeIsDark ? getColors().border : '#E7E6E2';
  }

  private rowIconColor(): string {
    return this.themeIsDark ? '#A1A1AA' : '#2F302D';
  }

  private rowTextColor(): string {
    return this.themeIsDark ? '#FAFAFA' : '#242521';
  }

  private rowChevronColor(): string {
    return this.themeIsDark ? '#71717A' : '#A8A6A0';
  }

  private rowPressedSurface(): string {
    return this.themeIsDark ? getColors().subtle : '#EDEBE6';
  }

  private pathSurfaceColor(): string {
    return this.themeIsDark ? getColors().raisedSurface : '#F1F0ED';
  }

  private pathBorderColor(): string {
    return this.themeIsDark ? getColors().border : '#E0DED8';
  }

  private pathTextColor(): string {
    return this.themeIsDark ? '#FAFAFA' : '#242521';
  }

  private messageTextColor(): string {
    return this.themeIsDark ? '#A1A1AA' : '#777777';
  }

  // --- Builders ---

  @Builder
  filesHeader() {
    Row({ space: 12 }) {
      Stack() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([this.headerIconColor()])
      }
      .width(40)
      .height(40)
      .borderRadius(20)
      .backgroundColor(getColors().raisedSurface)
      .border({ width: 1, color: this.headerBorderColor() })
      .onClick(() => {
        this.navPathStack.pop();
      })
      Row() {
        Text(this.triggerDeviceName())
          .fontSize(16)
          .fontWeight(600)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(19)
          .fontColor([getColors().faint])
      }
      .layoutWeight(1)
      .height(44)
      .padding({ left: 14, right: 14 })
      .borderRadius(14)
      .backgroundColor(getColors().raisedSurface)
      .border({ width: 1, color: this.headerBorderColor() })
      .id('files_device_selector')
      .enabled(this.hasOnlineDevice())
      .onClick(() => {
        this.openPicker();
      })
    }
    .width('100%')
    .height(64)
    .padding({ left: 18, right: 18 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  pickerOption(device: RemoteDevice) {
    Row() {
      Text(device.name)
        .fontSize(14)
        .fontWeight(600)
        .lineHeight(19)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (device.id === this.deviceId) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(18)
          .fontColor([getColors().ink])
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.handleDeviceChange(device);
    })
  }

  @Builder
  pickerOverlay() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.pickerOpen = false;
        })
      Scroll() {
        Column() {
          ForEach(this.devices, (device: RemoteDevice) => {
            if (device.status === 'online') {
              this.pickerOption(device)
            }
          }, (device: RemoteDevice) => device.id)
        }
        .width('100%')
        .padding({ top: 14, bottom: 14 })
      }
      .scrollBar(BarState.Off)
      .width(this.pickerWidth)
      .constraintSize({ maxHeight: 328 })
      .borderRadius(18)
      .backgroundColor(this.themeIsDark ? getColors().subtle : getColors().raisedSurface)
      .border({ width: 1, color: this.themeIsDark ? Color.Transparent : getColors().border })
      .position({ x: this.pickerAnchor.x, y: this.pickerAnchor.y + this.pickerAnchor.height + 4 })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  pathBar() {
    Row({ space: 8 }) {
      Row() {
        Text(this.displayedPathText())
          .fontSize(15)
          .fontWeight(800)
          .lineHeight(20)
          .fontColor(this.pathTextColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .layoutWeight(1)
      .height(52)
      .padding({ left: 13, right: 13 })
      .borderRadius(13)
      .backgroundColor(this.pathSurfaceColor())
      .border({ width: 1.2, color: this.pathBorderColor() })
      .alignItems(VerticalAlign.Center)
      Stack() {
        SymbolGlyph(this.pathCopied ? $r('sys.symbol.checkmark') : $r('sys.symbol.doc_text_on_doc_text'))
          .fontSize(20)
          .fontColor([this.pathTextColor()])
      }
      .width(52)
      .height(52)
      .borderRadius(13)
      .backgroundColor(this.pathSurfaceColor())
      .border({ width: 1.2, color: this.pathBorderColor() })
      .onClick(() => {
        this.copyPathToClipboard();
      })
    }
    .width('100%')
    .height(52)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  listMessageRow() {
    Text(this.listMessageText())
      .fontSize(13)
      .fontWeight(600)
      .fontColor(this.messageTextColor())
      .width('100%')
      .padding({ left: 8, right: 8, top: 16, bottom: 16 })
  }

  @Builder
  parentRow() {
    Row({ space: 12 }) {
      Stack() {
        SymbolGlyph($r('sys.symbol.folder'))
          .fontSize(22)
          .fontColor([this.rowIconColor()])
      }
      .width(40)
      .height(40)
      .borderRadius(12)
      Text('..')
        .fontSize(15)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(this.rowTextColor())
        .maxLines(1)
        .layoutWeight(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(20)
        .fontColor([this.rowChevronColor()])
    }
    .width('100%')
    .height(60)
    .borderRadius(16)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.pressedRowPath === '..' ? this.rowPressedSurface() : Color.Transparent)
    .shadow({
      radius: this.pressedRowPath === '..' ? 16 : 0,
      color: this.themeIsDark ? '#77000000' : '#30000000'
    })
    .onClick(() => {
      this.goUp();
    })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedRowPath = '..';
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedRowPath = '';
      }
    })
  }

  @Builder
  directoryEntryRow(entry: RemoteDirectoryEntry) {
    Row({ space: 12 }) {
      Stack() {
        SymbolGlyph(this.entrySymbol(entry))
          .fontSize(22)
          .fontColor([this.rowIconColor()])
      }
      .width(40)
      .height(40)
      .borderRadius(12)
      Text(entry.name)
        .fontSize(15)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(this.rowTextColor())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (entry.type === 'directory') {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(20)
          .fontColor([this.rowChevronColor()])
      }
    }
    .width('100%')
    .height(60)
    .borderRadius(16)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.pressedRowPath === entry.path ? this.rowPressedSurface() : Color.Transparent)
    .shadow({
      radius: this.pressedRowPath === entry.path ? 16 : 0,
      color: this.themeIsDark ? '#77000000' : '#30000000'
    })
    .onClick(() => {
      this.openEntry(entry);
    })
    .gesture(
      LongPressGesture()
        .onAction(() => {
          this.openRowMenu(entry);
        })
    )
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedRowPath = entry.path;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedRowPath = '';
      }
    })
  }

  @Builder
  browserContent() {
    Column({ space: 12 }) {
      this.pathBar()
      List({ space: 1 }) {
        if (this.entries.length === 0) {
          ListItem() {
            this.listMessageRow()
          }
        }
        if (canGoUp(this.currentPath)) {
          ListItem() {
            this.parentRow()
          }
        }
        ForEach(this.entries, (entry: RemoteDirectoryEntry) => {
          ListItem() {
            this.directoryEntryRow(entry)
          }
        }, (entry: RemoteDirectoryEntry) => entry.path)
        ListItem() {
          Column()
            .width('100%')
            .height(24)
        }
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 16, right: 16, top: 6 })
  }

  @Builder
  previewContent() {
    Column() {
      Row({ space: 8 }) {
        Button($r('app.string.files_back'))
          .fontSize(13)
          .height(32)
          .padding({ left: 12, right: 12 })
          .backgroundColor(getColors().raisedSurface)
          .fontColor(getColors().inkSoft)
          .onClick(() => {
            this.closeViewer();
          })
        Text(this.fileName)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.fileSizeLabel)
          .fontSize(12)
          .fontColor(getColors().faint)
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 4, bottom: 4 })
      Row({ space: 8 }) {
        Button() {
          SymbolGlyph($r('sys.symbol.magnifyingglass'))
            .fontSize(16)
            .fontColor([getColors().inkSoft])
        }
        .fontSize(13)
        .height(32)
        .width(38)
        .padding(0)
        .backgroundColor(this.searchOpen ? getColors().accentPurpleSurface : getColors().raisedSurface)
        .onClick(() => {
          this.toggleSearch();
        })
        Button(this.copiedContent ? $r('app.string.files_copied_content')
          : $r('app.string.files_copy_content'))
          .fontSize(13)
          .height(32)
          .padding({ left: 12, right: 12 })
          .backgroundColor(getColors().raisedSurface)
          .fontColor(this.copiedContent ? getColors().noticeSuccess : getColors().inkSoft)
          .enabled(!this.fileBinary)
          .onClick(() => {
            this.copyFileContent();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 2, bottom: 4 })
      if (this.searchOpen) {
        Row({ space: 8 }) {
          TextInput({ text: this.searchQuery, placeholder: $r('app.string.files_search') })
            .fontSize(13)
            .height(32)
            .layoutWeight(1)
            .backgroundColor(getColors().matchedAccountSurface)
            .enterKeyType(EnterKeyType.Search)
            .onChange((value: string) => {
              this.searchQuery = value;
              this.applySearch();
            })
            .onSubmit(() => {
              this.stepSearch(1);
            })
          Text(`${this.searchCurrentOrdinal}/${this.searchTotal}`)
            .fontSize(11)
            .fontColor(getColors().muted)
          Button('↑')
            .fontSize(13)
            .height(32)
            .width(32)
            .padding(0)
            .backgroundColor(getColors().raisedSurface)
            .fontColor(getColors().inkSoft)
            .enabled(this.searchTotal > 0)
            .onClick(() => {
              this.stepSearch(-1);
            })
          Button('↓')
            .fontSize(13)
            .height(32)
            .width(32)
            .padding(0)
            .backgroundColor(getColors().raisedSurface)
            .fontColor(getColors().inkSoft)
            .enabled(this.searchTotal > 0)
            .onClick(() => {
              this.stepSearch(1);
            })
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 2, bottom: 4 })
      }
      if (this.viewerShowNotice()) {
        Text(this.viewerNotice())
          .fontSize(12)
          .fontColor(getColors().noticeWarning)
          .width('100%')
          .padding({ left: 16, right: 16 })
      }
      List({ scroller: this.scroller }) {
        LazyForEach(this.previewLines, (line: FilePreviewLine) => {
          ListItem() {
            Text(line.text.length > 0 ? line.text : ' ')
              .fontSize(12)
              .fontFamily('monospace')
              .fontColor(getColors().ink)
              .width('100%')
              .backgroundColor(line.isCurrent ? getColors().accentPurpleSurface
                : line.isMatch ? getColors().accentSurface : Color.Transparent)
          }
        }, (line: FilePreviewLine) => `${line.lineIndex}_${line.text.length}_${line.isMatch ? 1 : 0}`)
      }
      .backgroundColor(getColors().matchedAccountSurface)
      .width('100%')
      .layoutWeight(1)
      .padding(8)
      .cachedCount(6)
    }
    .width('100%')
    .layoutWeight(1)
  }

  @Builder
  pairFirstContent() {
    Column() {
      EmptyState({
        glyph: '\u{1F5A5}\u{FE0F}',
        message: $r('app.string.files_pair_first'),
        actionLabel: $r('app.string.home_pair_new_device'),
        actionSymbol: $r('sys.symbol.desktop'),
        onAction: (): void => {
          this.openPairing();
        }
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  allOfflineContent() {
    Column() {
      Text($r('app.string.files_all_devices_offline'))
        .fontSize(14)
        .fontWeight(600)
        .lineHeight(19)
        .fontColor(this.themeIsDark ? '#A1A1AA' : '#6F706A')
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 34, right: 34 })
  }

  @Builder
  deviceLoadingContent() {
    Column() {
      LoadingProgress()
        .width(28)
        .height(28)
        .color(getColors().muted)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  build() {
    NavDestination() {
      Stack() {
        Column()
          .width(0)
          .height(0)
          .position({ x: 0, y: 0 })
          .id('files_anchor_origin')
        Column() {
          this.filesHeader()
          if (this.devicesEmpty) {
            this.pairFirstContent()
          } else if (this.devices.length === 0 && this.loading) {
            this.deviceLoadingContent()
          } else if (this.selectedOnlineDevice() === null && this.errorMessage.length === 0) {
            this.allOfflineContent()
          } else if (this.viewingFile) {
            this.previewContent()
          } else {
            this.browserContent()
          }
        }
        .width('100%')
        .height('100%')

        if (this.pickerOpen) {
          this.pickerOverlay()
        }

        if (this.rowMenuOpen) {
          FileRowMenuOverlay({
            entryName: this.rowMenuEntryName,
            onCopyPath: (): void => {
              this.copyEntryPath(this.rowMenuEntryPath);
            },
            onClose: (): void => {
              this.closeRowMenu();
            }
          })
        }
      }
      .width('100%')
      .height('100%')
    }
    .hideTitleBar(true)
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      const raw = ctx.pathInfo.param as string;
      if (typeof raw === 'string' && raw.length > 0) {
        this.deviceId = raw;
      }
      this.start();
    })
    .onBackPressed((): boolean => {
      if (this.pickerOpen) {
        this.pickerOpen = false;
        return true;
      }
      if (this.rowMenuOpen) {
        this.closeRowMenu();
        return true;
      }
      return false;
    })
  }
}

@Builder
export function FilesPageBuilder() {
  FilesPage()
}
