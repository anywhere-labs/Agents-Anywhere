import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { CodeLinesView, CODE_LINE_HEIGHT } from '../../designsystem/AACodeLines';
import { AAIosInlineBar } from '../../designsystem/AAIosChrome';
import { AppEmptyState } from '../common/AppEmptyState';
import { TerminalContent } from '../terminal/TerminalContent';
import { AgentDevice, AgentSession } from '../../../model/AgentSession';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import { FilesController } from '../../../feature/files/FilesController';
import {
  FileEntry, FilesDirectory, TextFile, canonicalRemotePaths, displayRemotePath, emptyDirectory,
  initialRemoteFilePath, isWindowsDeviceOs, isWindowsDriveOverview, normalizeRemotePath,
  remoteFileRequest, remoteParentPath, remoteRootForPath, windowsDriveRoot,
} from '../../../feature/files/RemoteFileNavigation';
import {
  FileMatch, cycleFileMatch, fileMatchLabel, findFileMatches, scrollOffsetForLine,
} from '../../../feature/files/FileSearch';
import { normalizeCodeText } from '../../../feature/sessiondetail/CodeTokenizer';
import { sortedForDevicesPage } from '../../../feature/devices/DeviceAgentPreviews';
import { RemoteTerminalPool } from '../../../feature/terminal/RemoteTerminalPool';
import { RemoteTerminalController } from '../../../feature/terminal/RemoteTerminalController';
import { AALog } from '../../../common/AAAppLog';
import { copyTextToClipboard } from '../../../common/AAClipboard';
import { resolveString } from '../../../common/AAResources';

/**
 * Files page.
 *
 * Port of `ui/screens/files/FilesScreen.kt` and
 * `ui/screens/sessiondetail/SessionAgentFilesScreen.kt`.
 *
 * The page has two shapes, and which one it takes is decided by whether a
 * session was handed in:
 *
 *  - **device mode** (`session === null`): pick a device in the header — a 40dp
 *    back button, then a 44dp chip with the device name and a chevron — and
 *    browse that device from its root.
 *  - **session mode**: the session's own files/terminal pager. The header is a
 *    58dp row with a 36dp "Back" chip and a 196x42 Files/Terminal switcher, the
 *    file browser is rooted at the session's workspace, and the second tab is
 *    the terminal for that session (Android's pager page 2).
 *
 * The browser itself is shared by both modes:
 *
 *  - a 52dp path bar with a 52dp copy button beside it, 13dp radii and 1.2dp borders;
 *  - 60dp rows — 40dp icon tile, 15sp/20sp semi-bold name, a chevron on folders —
 *    that press to a `#EDEBE6` surface with a 14dp shadow for 180ms, and long-press
 *    to open a 188x54 copy-path menu;
 *  - a preview mode with a 30dp breadcrumb (a 28dp "Files" chip, a separator, the
 *    path in 11sp monospace) and a 16dp-radius card whose 44dp header holds the file
 *    name, a search button and a 1100ms copy button;
 *  - the file body itself is drawn by `CodeLinesView`, the same highlighter the
 *    conversation uses, so a file and a code fence render identically;
 *  - the header's search button opens the 46dp in-file search bar, which scans the
 *    preview, highlights every match and jumps between them with wrapping.
 */

/** The two halves of the session pager; Android's private `PushView`. */
enum FilesPushView {
  Files = 0,
  Terminal = 1,
}

/** The preview's code top padding, which the jump offset has to account for. */
const PREVIEW_TOP_PADDING: number = 4;

@Component
export struct FilesScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  state: SessionsState = SessionsState.empty();
  controller: FilesController | null = null;
  /** Device to open first; the session's device when reached from a session. */
  initialDeviceId: string = '';
  /**
   * The session whose files/terminal pager this is, or `null` for the device
   * browser. Android passes the whole session plus its device; the device is
   * looked up from `state` here.
   */
  session: AgentSession | null = null;
  /** Terminal pool, used only by the session pager's second tab. */
  pool: RemoteTerminalPool | null = null;
  onBack: () => void = () => {};
  onPairDevice: () => void = () => {};

  @State private selectedDeviceId: string = '';
  @State private directory: FilesDirectory = emptyDirectory('.');
  @State private resolvedRoot: string | null = null;
  @State private loading: boolean = false;
  @State private error: string = '';
  @State private selectedFile: FileEntry | null = null;
  @State private preview: TextFile | null = null;
  @State private previewLoading: boolean = false;
  @State private previewError: string = '';
  /** In-file search, mirroring Android's `searchOpen`/`searchQuery` pair. */
  @State private searchOpen: boolean = false;
  @State private searchQuery: string = '';
  /** The matches for the current query, recomputed when the query or file changes. */
  @State private searchMatches: FileMatch[] = [];
  /** Index into `searchMatches`, or -1 when there are none. */
  @State private searchIndex: number = -1;
  /** Path whose long-press menu is open, or empty. */
  @State private menuPath: string = '';
  @State private copyFlash: string = '';
  @State private pushView: FilesPushView = FilesPushView.Files;
  private copyTimer: number = -1;
  /** Drives the preview's vertical scroll so a jump can reach its line. */
  private previewScroller: Scroller = new Scroller();
  private static readonly SEARCH_FIELD_ID: string = 'aa-file-search';

  aboutToAppear(): void {
    if (this.isSessionMode()) {
      this.loadSessionRoot();
    } else {
      this.ensureDevice();
    }
  }

  aboutToDisappear(): void {
    if (this.copyTimer >= 0) {
      clearTimeout(this.copyTimer);
      this.copyTimer = -1;
    }
  }

  private devices(): AgentDevice[] {
    return sortedForDevicesPage(this.state.devices);
  }

  private isSessionMode(): boolean {
    return this.session !== null;
  }

  private sessionCwd(): string {
    const session: AgentSession | null = this.session;
    if (session === null || session.cwd === null) {
      return '';
    }
    return session.cwd;
  }

  /**
   * The device OS of the session's host.
   *
   * Android takes it from the device it was handed and falls back to inferring
   * Windows from the workspace path, which is the only hint available when the
   * device list has not caught up.
   */
  private sessionDeviceOs(): string | null {
    const session: AgentSession | null = this.session;
    if (session === null) {
      return null;
    }
    for (const device of this.state.devices) {
      if (device.id === session.connectorId) {
        return device.deviceOs;
      }
    }
    return session.cwd !== null && windowsDriveRoot(session.cwd) !== null ? 'windows' : null;
  }

  /** The connector the browser lists from: the session's, or the picked device's. */
  private connectorId(): string {
    const session: AgentSession | null = this.session;
    if (session !== null) {
      return session.connectorId;
    }
    const device: AgentDevice | null = this.selectedDevice();
    return device === null ? '' : device.id;
  }

  /**
   * The root a listed path is resolved against.
   *
   * A session's root is fixed at its workspace, so navigating never changes it;
   * the device browser instead follows the resolved POSIX root and treats a
   * Windows drive overview as rootless.
   */
  private browseRoot(): string {
    if (this.isSessionMode()) {
      return this.sessionCwd();
    }
    return this.resolvedRoot !== null && this.resolvedRoot.length > 0 ? this.resolvedRoot : '~';
  }

  /**
   * The session pager's first tab: the workspace, or the message explaining that
   * there is none.
   *
   * Android's `LaunchedEffect(session?.id, session?.cwd, deviceOs)`.
   */
  private loadSessionRoot(): void {
    this.selectedFile = null;
    this.preview = null;
    this.previewError = '';
    this.menuPath = '';
    this.closeSearch();
    this.directory = emptyDirectory('.');
    if (this.sessionCwd().length === 0) {
      this.error = resolveString($r('app.string.files_session_no_workspace'));
      return;
    }
    this.error = '';
    void this.loadDirectory('.');
  }

  private selectedDevice(): AgentDevice | null {
    for (const device of this.devices()) {
      if (device.id === this.selectedDeviceId && device.online) {
        return device;
      }
    }
    return null;
  }

  /**
   * Keeps the picker on an online device.
   *
   * Android's `LaunchedEffect(devices)`: when the chosen device goes offline the
   * first online one takes over, and a session-opened device is preferred on entry.
   */
  private ensureDevice(): void {
    const devices: AgentDevice[] = this.devices();
    for (const device of devices) {
      if (device.id === this.selectedDeviceId && device.online) {
        return;
      }
    }
    let next: AgentDevice | null = null;
    if (this.selectedDeviceId.length === 0 && this.initialDeviceId.length > 0) {
      for (const device of devices) {
        if (device.id === this.initialDeviceId && device.online) {
          next = device;
          break;
        }
      }
    }
    if (next === null) {
      for (const device of devices) {
        if (device.online) {
          next = device;
          break;
        }
      }
    }
    if (next === null) {
      return;
    }
    this.resetForDevice(next);
  }

  /** Resets the browser and loads the device's initial directory. */
  private resetForDevice(device: AgentDevice): void {
    this.selectedDeviceId = device.id;
    this.directory = emptyDirectory(initialRemoteFilePath(device.deviceOs));
    this.resolvedRoot = null;
    this.selectedFile = null;
    this.preview = null;
    this.previewError = '';
    this.previewLoading = false;
    this.menuPath = '';
    this.closeSearch();
    if (device.online) {
      this.error = '';
      void this.loadDirectory(isWindowsDeviceOs(device.deviceOs) ? '' : '.');
    } else {
      this.error = 'This device is offline.';
    }
  }

  /**
   * Lists a directory.
   *
   * Android's `load`: the request root comes from the path itself on Windows and
   * from the resolved root elsewhere; the answer is canonicalized, and a POSIX
   * `~` root is replaced by the directory the Server actually resolved. The
   * session pager never re-resolves its root — it always asks for the workspace.
   */
  private async loadDirectory(path: string): Promise<void> {
    const controller: FilesController | null = this.controller;
    if (controller === null) {
      this.error = resolveString($r('app.string.files_load_failed'));
      return;
    }
    const connectorId: string = this.connectorId();
    if (connectorId.length === 0) {
      this.error = this.isSessionMode()
        ? resolveString($r('app.string.files_session_no_workspace'))
        : resolveString($r('app.string.files_device_offline'));
      return;
    }
    const deviceOs: string | null = this.deviceOs();
    const request = remoteFileRequest(path, deviceOs, this.browseRoot());
    this.loading = true;
    this.error = '';
    try {
      const listing: FilesDirectory = await controller.listFiles(connectorId, request.root, request.path);
      const canonical: FilesDirectory = canonicalRemotePaths(listing, request, deviceOs);
      this.directory = canonical;
      if (this.isSessionMode()) {
        // The root is the workspace and never moves.
        this.resolvedRoot = null;
      } else if (isWindowsDeviceOs(deviceOs)) {
        const drive: string | null = canonical.path.length >= 2
          && canonical.path.charAt(1) === ':' ? `${canonical.path.substring(0, 2)}\\` : null;
        this.resolvedRoot = drive;
      } else if (request.root === '~') {
        this.resolvedRoot = canonical.path.length > 0 ? canonical.path : null;
      }
    } catch (error) {
      AALog.warn(`Directory listing failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.error = error instanceof Error ? error.message : resolveString($r('app.string.files_load_failed'));
    } finally {
      this.loading = false;
    }
  }

  /** Opens a file's preview. */
  private async openFile(entry: FileEntry): Promise<void> {
    const controller: FilesController | null = this.controller;
    const connectorId: string = this.connectorId();
    if (controller === null || connectorId.length === 0) {
      return;
    }
    this.selectedFile = entry;
    this.preview = null;
    this.previewError = '';
    this.previewLoading = true;
    // Android resets the query and the result when a file is loaded, but leaves
    // the bar itself open.
    this.resetSearchResults();
    const path: string = normalizeRemotePath(entry.path);
    const root: string = remoteRootForPath(path, this.deviceOs(), this.browseRoot());
    try {
      this.preview = await controller.readTextFile(connectorId, root, path);
      this.recomputeSearchMatches();
    } catch (error) {
      AALog.warn(`File preview failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.previewError = error instanceof Error ? error.message : resolveString($r('app.string.files_open_failed'));
    } finally {
      this.previewLoading = false;
    }
  }

  private backToFiles(): void {
    this.selectedFile = null;
    this.preview = null;
    this.previewError = '';
    this.closeSearch();
  }

  // ------------------------------------------------------------ in-file search

  /**
   * Android's `searchOpen = false` plus the result reset.
   *
   * Leaving the preview or switching directory drops the whole search, exactly as
   * `onBackToFiles` and the two directory effects do.
   */
  private closeSearch(): void {
    this.searchOpen = false;
    this.searchQuery = '';
    this.searchMatches = [];
    this.searchIndex = -1;
  }

  /** Keeps the previous query but drops the stale matches (file switch). */
  private resetSearchResults(): void {
    this.searchQuery = '';
    this.searchMatches = [];
    this.searchIndex = -1;
  }

  /** The preview's lines, in the coordinates the renderer's token spans use. */
  private previewLines(): string[] {
    const file: TextFile | null = this.preview;
    if (file === null || file.binary) {
      return [];
    }
    return normalizeCodeText(file.content).split('\n');
  }

  /** Android's `searchController.search(query)`: a fresh scan, first match selected. */
  private recomputeSearchMatches(): void {
    if (!this.searchOpen || this.searchQuery.length === 0) {
      this.searchMatches = [];
      this.searchIndex = -1;
      return;
    }
    const matches: FileMatch[] = findFileMatches(this.previewLines(), this.searchQuery);
    this.searchMatches = matches;
    this.searchIndex = matches.length > 0 ? 0 : -1;
    this.scrollToSearchMatch();
  }

  private onSearchQueryChange(value: string): void {
    this.searchQuery = value;
    this.recomputeSearchMatches();
  }

  /** Android's `next()`/`previous()`, both cyclic. */
  private stepSearchMatch(forward: boolean): void {
    if (this.searchMatches.length <= 0) {
      this.searchIndex = -1;
      return;
    }
    this.searchIndex = cycleFileMatch(this.searchIndex, this.searchMatches.length, forward);
    this.scrollToSearchMatch();
  }

  /** Brings the current match's line into view. */
  private scrollToSearchMatch(): void {
    if (this.searchIndex < 0 || this.searchIndex >= this.searchMatches.length) {
      return;
    }
    const line: number = this.searchMatches[this.searchIndex].line;
    this.previewScroller.scrollTo({
      xOffset: 0,
      yOffset: scrollOffsetForLine(line, CODE_LINE_HEIGHT, PREVIEW_TOP_PADDING),
    });
  }

  private toggleSearch(): void {
    if (this.searchOpen) {
      // Android keeps the query when the bar is closed and re-runs it on reopen.
      this.searchOpen = false;
      return;
    }
    this.searchOpen = true;
    this.recomputeSearchMatches();
    // Android's `LaunchedEffect(query, result.total)` refocuses the field and
    // brings the keyboard back up whenever the bar opens.
    setTimeout(() => {
      this.getUIContext().getFocusController().requestFocus(FilesScreen.SEARCH_FIELD_ID);
    }, 0);
  }

  /** The root the path bar joins against. */
  private rootPath(): string {
    if (this.isSessionMode()) {
      return this.sessionCwd();
    }
    const device: AgentDevice | null = this.selectedDevice();
    if (device !== null && isWindowsDriveOverview(this.directory.path, device.deviceOs)) {
      return '';
    }
    return this.resolvedRoot ?? '~';
  }

  private displayPath(rawPath: string, deviceOs: string | null): string {
    return displayRemotePath(
      this.rootPath(), rawPath, deviceOs, resolveString($r('app.string.files_windows_drives')),
    );
  }

  private flashCopy(value: string): void {
    this.copyFlash = value;
    if (this.copyTimer >= 0) {
      clearTimeout(this.copyTimer);
    }
    this.copyTimer = setTimeout(() => {
      this.copyFlash = '';
      this.copyTimer = -1;
    }, 1100);
  }

  build() {
    Column() {
      if (this.isSessionMode()) {
        this.SessionHeader()

        if (this.pushView === FilesPushView.Terminal) {
          TerminalContent({
            colors: this.colors,
            darkMode: this.colors.isDark,
            controller: this.sessionTerminalController(),
            terminalKey: this.session === null ? '' : (this.session as AgentSession).id,
            canReconnect: this.session !== null,
            onStart: () => {
              const current: AgentSession | null = this.session;
              const terminal: RemoteTerminalController | null = this.sessionTerminalController();
              if (current !== null && terminal !== null) {
                void terminal.ensureStarted(current);
              }
            },
            onReconnect: () => {
              const current: AgentSession | null = this.session;
              const terminal: RemoteTerminalController | null = this.sessionTerminalController();
              if (current !== null && terminal !== null) {
                void terminal.reconnectSession(current);
              }
            },
            onClear: () => {
              const current: AgentSession | null = this.session;
              const terminal: RemoteTerminalController | null = this.sessionTerminalController();
              if (current !== null && terminal !== null) {
                void terminal.restartSession(current);
              }
            },
          })
            .layoutWeight(1)
        } else if (this.selectedFile === null) {
          this.FileList()
        } else {
          this.FilePreview()
        }
      } else {
        this.Header()

        if (this.devices().length === 0) {
          AppEmptyState({
            colors: this.colors,
            message: $r('app.string.files_pair_first'),
            buttonLabel: $r('app.string.home_pair_new_device'),
            buttonIconCommands: AA_ICONS.MONITOR,
            onButtonClick: () => this.onPairDevice(),
          })
            .layoutWeight(1)
        } else if (this.selectedDevice() === null) {
          this.EmptyMessage($r('app.string.files_all_devices_offline'))
        } else if (this.selectedFile === null) {
          this.FileList()
        } else {
          this.FilePreview()
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .alignItems(HorizontalAlign.Start)
  }

  /** The session pager's terminal, or `null` before the session is known. */
  private sessionTerminalController(): RemoteTerminalController | null {
    const pool: RemoteTerminalPool | null = this.pool;
    const current: AgentSession | null = this.session;
    if (pool === null || current === null) {
      return null;
    }
    return pool.forSession(current.id);
  }

  /**
   * The session pager's 58dp header: a back chip on the left, the Files/Terminal
   * switcher on the right.
   */
  @Builder
  SessionHeader() {
    // iOS's sheet chrome: an inline navigation bar named after the active tab,
    // with the Files/Terminal switch below it as a segmented control. Android's
    // 36dp "back" pill is gone.
    Column() {
      AAIosInlineBar({
        colors: this.colors,
        title: this.pushView === FilesPushView.Terminal
          ? $r('app.string.common_terminal')
          : $r('app.string.common_files'),
        onBack: () => this.onBack(),
      })

      this.PushSwitcher()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * The Files/Terminal switch as iOS's segmented control: a `#7676801F` track
   * with a white selected pill, 13sp/600 labels and no glyphs — iOS segmented
   * controls are text-only — sitting under the inline navigation bar.
   */
  @Builder
  PushSwitcher() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column()
        .width('50%')
        .height(28)
        .borderRadius(7)
        .backgroundColor(this.colors.isDark ? '#48484A' : '#FFFFFF')
        .shadow({
          radius: 3,
          color: this.colors.isDark ? '#33000000' : '#1F000000',
          offsetX: 0,
          offsetY: 1,
        })
        .margin({
          left: this.pushView === FilesPushView.Files ? 2 : '50%',
          top: 2,
        })
        .animation({ duration: 180, curve: Curve.EaseInOut })

      Row() {
        this.SwitcherTab($r('app.string.common_files'), FilesPushView.Files)
        this.SwitcherTab($r('app.string.common_terminal'), FilesPushView.Terminal)
      }
      .width('100%')
      .height('100%')
      .padding(2)
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height(32)
    .borderRadius(9)
    .backgroundColor(this.colors.isDark ? '#1FFFFFFF' : '#1F767680')
    .margin({ left: 16, right: 16, bottom: 8 })
    .clip(true)
  }

  /** One half of the segmented control: a label, no glyph. */
  @Builder
  SwitcherTab(label: ResourceStr, view: FilesPushView) {
    Row() {
      Text(label)
        .fontSize(13)
        .fontWeight(600)
        .fontColor(this.switcherTabColor(view))
        .maxLines(1)
    }
    .layoutWeight(1)
    .height(28)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.pushView = view;
    })
  }

  private switcherTabColor(view: FilesPushView): string {
    if (this.pushView === view) {
      return this.colors.isDark ? '#FAFAFA' : '#242521';
    }
    return this.colors.isDark ? '#71717A' : '#8B8983';
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

  /** 64dp header: back, then the device chip with its picker menu. */
  @Builder
  Header() {
    // iOS's inline navigation bar naming the selected device, whose picker is the
    // trailing glyph. Android's bordered chip is gone; the menu is unchanged.
    AAIosInlineBar({
      colors: this.colors,
      title: this.selectedDevice() === null
        ? $r('app.string.devices_no_online')
        : (this.selectedDevice() as AgentDevice).name,
      onBack: () => this.onBack(),
      trailingSlots: 1,
    }) {
      Column() {
        AAIcon({ commands: AA_ICONS.CHEVRON_DOWN, iconSize: 20, color: this.colors.ink })
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .accessibilityText($r('app.string.devices_title'))
      .onClick(() => {
        this.devicePickerOpen = !this.devicePickerOpen;
      })
      .bindMenu(this.devicePickerOpen, this.DevicePicker(), {
        placement: Placement.BottomRight,
        enableArrow: false,
        onDisappear: () => {
          this.devicePickerOpen = false;
        },
      })
    }
  }

  @State private devicePickerOpen: boolean = false;

  @Builder
  DevicePicker() {
    Column() {
      ForEach(this.devices(), (device: AgentDevice) => {
        Row({ space: 10 }) {
          AAIcon({
            commands: device.online ? AA_ICONS.MONITOR : AA_ICONS.MONITOR,
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
          if (device.online) {
            this.resetForDevice(device);
          }
        })
      }, (device: AgentDevice) => `picker-${device.id}`)
    }
    .padding({ top: 6, bottom: 6 })
    .borderRadius(14)
    .backgroundColor(this.colors.raisedSurface)
  }

  // ----------------------------------------------------------------- listing

  @Builder
  FileList() {
    Column({ space: 12 }) {
      this.PathBar()

      List({ space: 1 }) {
        if (this.loading && this.directory.entries.length === 0) {
          ListItem() {
            this.FilesMessage($r('app.string.files_loading'))
          }
        } else if (this.error.length > 0 && this.directory.entries.length === 0) {
          ListItem() {
            this.FilesMessage(this.error)
          }
        } else if (!this.loading && this.directory.entries.length === 0) {
          ListItem() {
            this.FilesMessage($r('app.string.files_empty_directory'))
          }
        } else if (this.error.length > 0) {
          ListItem() {
            this.FilesMessage(this.error)
          }
        }

        if (this.parentPath() !== null) {
          ListItem() {
            FileListRow({
              colors: this.colors,
              name: '..',
              iconCommands: AA_ICONS.FOLDER,
              copyPath: this.displayPath(this.parentPath() as string, this.deviceOs()),
              menuOpen: this.menuPath === this.parentPath(),
              trailingChevron: true,
              flash: this.copyFlash === this.displayPath(this.parentPath() as string, this.deviceOs()),
              onOpenMenu: () => {
                this.menuPath = this.parentPath() as string;
              },
              onDismissMenu: () => {
                this.menuPath = '';
              },
              onCopyPath: (value: string) => {
                this.copyPath(value);
              },
              onTap: () => {
                this.menuPath = '';
                void this.loadDirectory(this.parentPath() as string);
              },
            })
          }
        }

        ForEach(this.directory.entries, (entry: FileEntry) => {
          ListItem() {
            FileListRow({
              colors: this.colors,
              name: entry.name,
              iconCommands: entry.isDirectory ? AA_ICONS.FOLDER : fileIconFor(entry.name),
              copyPath: this.displayPath(entry.path, this.deviceOs()),
              menuOpen: this.menuPath === entry.path,
              trailingChevron: entry.isDirectory,
              flash: this.copyFlash === this.displayPath(entry.path, this.deviceOs()),
              onOpenMenu: () => {
                this.menuPath = entry.path;
              },
              onDismissMenu: () => {
                this.menuPath = '';
              },
              onCopyPath: (value: string) => {
                this.copyPath(value);
              },
              onTap: () => {
                this.menuPath = '';
                if (entry.isDirectory) {
                  void this.loadDirectory(entry.path);
                } else {
                  void this.openFile(entry);
                }
              },
            })
          }
        }, (entry: FileEntry) => `entry-${entry.path}`)

        ListItem() {
          Column().height(24)
        }
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 16, right: 16, top: 6 })
    .alignItems(HorizontalAlign.Start)
  }

  private deviceOs(): string | null {
    if (this.isSessionMode()) {
      return this.sessionDeviceOs();
    }
    const device: AgentDevice | null = this.selectedDevice();
    return device === null ? null : device.deviceOs;
  }

  private parentPath(): string | null {
    if (this.isSessionMode()) {
      return remoteParentPath(this.directory.path, this.deviceOs());
    }
    const device: AgentDevice | null = this.selectedDevice();
    return remoteParentPath(
      this.directory.path, this.deviceOs(), isWindowsDeviceOs(device === null ? null : device.deviceOs),
    );
  }

  private copyPath(value: string): void {
    void copyTextToClipboard(value).then((done: boolean) => {
      if (done) {
        this.flashCopy(value);
      }
    });
    this.menuPath = '';
  }

  @Builder
  PathBar() {
    Row({ space: 8 }) {
      Row() {
        Text(this.displayPath(this.directory.path, this.deviceOs()).length > 0
          ? this.displayPath(this.directory.path, this.deviceOs())
          : '.')
          .fontSize(15)
          .lineHeight(20)
          .fontWeight(800)
          .fontColor(this.colors.isDark ? '#FAFAFA' : '#242521')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .layoutWeight(1)
      .height(52)
      .padding({ left: 13, right: 13 })
      .borderRadius(13)
      .backgroundColor(this.colors.isDark ? this.colors.raisedSurface : '#F1F0ED')
      .border({
        width: 1.2,
        color: this.colors.isDark ? this.colors.border : '#E0DED8',
      })
      .alignItems(VerticalAlign.Center)

      Column() {
        AAIcon({
          commands: this.copyFlash === this.displayPath(this.directory.path, this.deviceOs())
            ? AA_ICONS.CHECK
            : AA_ICONS.COPY,
          iconSize: 20,
          color: this.colors.isDark ? '#FAFAFA' : '#242521',
        })
      }
      .width(52)
      .height(52)
      .justifyContent(FlexAlign.Center)
      .borderRadius(13)
      .backgroundColor(this.colors.isDark ? this.colors.raisedSurface : '#F1F0ED')
      .border({
        width: 1.2,
        color: this.colors.isDark ? this.colors.border : '#E0DED8',
      })
      .onClick(() => this.copyPath(this.displayPath(this.directory.path, this.deviceOs())))
    }
    .width('100%')
    .height(52)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  FilesMessage(message: ResourceStr) {
    Text(message)
      .fontSize(13)
      .fontWeight(600)
      .fontColor(this.colors.isDark ? '#A1A1AA' : '#777777')
      .padding({ left: 8, right: 8, top: 16, bottom: 16 })
  }

  // ----------------------------------------------------------------- preview

  @Builder
  FilePreview() {
    Column({ space: 12 }) {
      this.Breadcrumb()

      Column() {
        this.PreviewHeader()

        if (this.searchOpen) {
          InlineFileSearchBar({
            colors: this.colors,
            query: this.searchQuery,
            resultLabel: fileMatchLabel(this.searchIndex, this.searchMatches.length),
            fieldId: FilesScreen.SEARCH_FIELD_ID,
            onQueryChange: (value: string) => this.onSearchQueryChange(value),
            onPrevious: () => this.stepSearchMatch(false),
            onNext: () => this.stepSearchMatch(true),
          })
        }

        Column() {
          if (this.previewLoading) {
            this.PreviewMessage($r('app.string.files_loading_file'))
          } else if (this.previewError.length > 0) {
            this.PreviewMessage(this.previewError)
          } else if (this.preview !== null && this.preview.binary) {
            this.PreviewMessage($r('app.string.files_binary_preview_unavailable'))
          } else if (this.preview === null) {
            this.PreviewMessage($r('app.string.files_open_file_to_preview'))
          } else {
            Scroll(this.previewScroller) {
              CodeLinesView({
                colors: this.colors,
                label: this.preview.name.length > 0 ? this.preview.name
                  : (this.selectedFile as FileEntry).name,
                code: this.preview.content,
                fixedHeight: 0,
                showGutter: true,
                topPadding: PREVIEW_TOP_PADDING,
                matches: this.searchOpen ? this.searchMatches : [],
                currentMatch: this.searchOpen ? this.searchIndex : -1,
              })
            }
            .scrollable(ScrollDirection.Vertical)
            .scrollBar(BarState.Auto)
            .width('100%')
            .height('100%')
            .align(Alignment.TopStart)
          }
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 8, bottom: 12 })
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
      .borderRadius(16)
      .backgroundColor(this.colors.isDark ? '#09090B' : '#FFFFFF')
      .border({
        width: 1.2,
        color: this.colors.isDark ? '#27272A' : '#E7E5E0',
      })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 16, right: 16, top: 6 })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  Breadcrumb() {
    Row({ space: 6 }) {
      Row({ space: 5 }) {
        AAIcon({
          commands: AA_ICONS.CHEVRON_LEFT,
          iconSize: 13,
          color: this.colors.isDark ? '#E4E4E7' : '#444540',
        })
        Text($r('app.string.common_files'))
          .fontSize(11)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.isDark ? '#E4E4E7' : '#444540')
      }
      .height(28)
      .padding({ left: 10, right: 10 })
      .borderRadius(14)
      .backgroundColor(this.colors.isDark ? this.colors.subtle : '#F1F0ED')
      .alignItems(VerticalAlign.Center)
      .onClick(() => this.backToFiles())

      Text('/')
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.isDark ? '#71717A' : '#A8A6A0')

      Text(this.selectedFile === null ? '' : this.displayPath(
        (this.selectedFile as FileEntry).path, this.deviceOs(),
      ))
        .fontSize(11)
        .fontWeight(600)
        .fontFamily('monospace')
        .fontColor(this.colors.isDark ? '#A1A1AA' : '#686862')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .height(30)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  PreviewHeader() {
    Row({ space: 8 }) {
      Text(this.selectedFile === null ? '' : (this.selectedFile as FileEntry).name)
        .fontSize(15)
        .fontWeight(800)
        .fontColor(this.colors.isDark ? '#FAFAFA' : '#111111')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      PreviewIconButton({
        colors: this.colors,
        commands: AA_ICONS.SEARCH,
        buttonEnabled: true,
        copied: false,
        description: $r('app.string.files_search_in_file'),
        onTap: () => this.toggleSearch(),
      })

      PreviewIconButton({
        colors: this.colors,
        commands: this.copyFlash === 'preview' ? AA_ICONS.CHECK : AA_ICONS.COPY,
        buttonEnabled: this.preview !== null && !this.preview.binary
          && this.preview.content.trim().length > 0,
        copied: this.copyFlash === 'preview',
        description: this.copyFlash === 'preview'
          ? $r('app.string.files_copied_code') : $r('app.string.files_copy_code'),
        onTap: () => {
          const file: TextFile | null = this.preview;
          if (file === null || file.content.trim().length === 0) {
            return;
          }
          void copyTextToClipboard(file.content).then((done: boolean) => {
            if (done) {
              this.flashCopy('preview');
            }
          });
        },
      })
    }
    .width('100%')
    .height(44)
    .padding({ left: 12, right: 12 })
    .backgroundColor(this.colors.isDark ? this.colors.raisedSurface : '#FFFFFF')
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  PreviewMessage(message: ResourceStr) {
    Text(message)
      .fontSize(13)
      .lineHeight(19)
      .fontWeight(600)
      .fontColor(this.colors.isDark ? '#A1A1AA' : '#777777')
      .padding({ left: 12, right: 12, top: 16 })
      .textAlign(TextAlign.Start)
  }
}

/**
 * The 46dp in-file search bar.
 *
 * Port of `InlineFileSearchControls` in `SessionAgentFilesScreen.kt`: a 34dp
 * 12dp-radius field with a 14dp search glyph, the `current/total` counter in 11sp
 * extra-bold monospace, and the two 30dp round step buttons. Return re-runs the
 * search forward, which is Android's `ImeAction.Search { onNext() }`.
 */
@Component
struct InlineFileSearchBar {
  colors: AAColors = AA_LIGHT_COLORS;
  /** The field's own copy, so typing is not fought by the incoming query. */
  @Prop @Watch('onQueryChanged') query: string = '';
  resultLabel: string = '';
  fieldId: string = '';
  onQueryChange: (value: string) => void = () => {};
  onPrevious: () => void = () => {};
  onNext: () => void = () => {};

  @State private field: string = '';

  aboutToAppear(): void {
    this.field = this.query;
  }

  onQueryChanged(): void {
    if (this.field !== this.query) {
      this.field = this.query;
    }
  }

  private muted(): string {
    return this.colors.isDark ? '#A1A1AA' : '#686862';
  }

  private text(): string {
    return this.colors.isDark ? '#FAFAFA' : '#111111';
  }

  private fieldBackground(): string {
    return this.colors.isDark ? this.colors.subtle : '#FFFFFF';
  }

  private fieldBorder(): string {
    return this.colors.isDark ? '#27272A' : '#E1DED7';
  }

  build() {
    Row({ space: 8 }) {
      Row({ space: 7 }) {
        AAIcon({ commands: AA_ICONS.SEARCH, iconSize: 14, color: this.muted() })

        TextInput({ text: this.field, placeholder: $r('app.string.files_search') })
          .id(this.fieldId)
          .layoutWeight(1)
          .height(34)
          .padding(0)
          .backgroundColor('#00000000')
          .borderRadius(0)
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontFamily('monospace')
          .fontColor(this.text())
          .placeholderColor(this.muted())
          .placeholderFont({ size: 12, weight: FontWeight.Bold, family: 'monospace' })
          .caretColor(this.text())
          .enterKeyType(EnterKeyType.Search)
          .onChange((value: string) => {
            this.field = value;
            this.onQueryChange(value);
          })
          .onSubmit(() => this.onNext())
      }
      .layoutWeight(1)
      .height(34)
      .padding({ left: 10, right: 10 })
      .borderRadius(12)
      .backgroundColor(this.fieldBackground())
      .border({ width: 1, color: this.fieldBorder() })

      Text(this.resultLabel)
        .fontSize(11)
        .fontWeight(800)
        .fontFamily('monospace')
        .fontColor(this.muted())
        .maxLines(1)

      SearchStepButton({
        colors: this.colors,
        commands: AA_ICONS.CHEVRON_UP,
        onTap: () => this.onPrevious(),
      })

      SearchStepButton({
        colors: this.colors,
        commands: AA_ICONS.CHEVRON_DOWN,
        onTap: () => this.onNext(),
      })
    }
    .width('100%')
    .height(46)
    .padding({ left: 12, right: 12 })
    .backgroundColor(this.colors.isDark ? '#111113' : '#F8F7F4')
    .alignItems(VerticalAlign.Center)
  }
}

/** One 30dp round step button of the in-file search bar. */
@Component
struct SearchStepButton {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({
        commands: this.commands,
        iconSize: 15,
        color: this.colors.isDark ? '#E4E4E7' : '#444540',
      })
    }
    .width(30)
    .height(30)
    .justifyContent(FlexAlign.Center)
    .borderRadius(15)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : '#FFFFFF')
    .border({ width: 1, color: this.colors.isDark ? '#27272A' : '#E1DED7' })
    .onClick(() => this.onTap())
  }
}

/** A 44dp icon button inside the preview card's header. */
@Component
struct PreviewIconButton {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  copied: boolean = false;
  /** Android's `contentDescription`, which names the action for a screen reader. */
  description: Resource = $r('app.string.common_copy');
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({
        commands: this.commands,
        iconSize: 19,
        color: withAlpha(this.colors.isDark ? '#FAFAFA' : '#111111', this.buttonEnabled ? 1 : 0.45),
      })
    }
    .width(36)
    .height(36)
    .justifyContent(FlexAlign.Center)
    .borderRadius(12)
    .backgroundColor(this.colors.isDark ? '#27272A' : '#F5F4F0')
    .border({
      width: 1,
      color: this.colors.isDark ? '#3F3F46' : '#E5E2DC',
    })
    .accessibilityText(this.description)
    .onClick(() => {
      if (this.buttonEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * One row in the browser.
 *
 * Android's `FileListRow`: 60dp tall, 16dp radius, a `#EDEBE6` (dark: subtle)
 * surface that fades in while pressed, a 14dp shadow for the same 180ms, a 40dp
 * icon tile, the name at 15sp/20sp semi-bold and an optional trailing chevron.
 * Long-press opens the copy-path menu; a tap dismisses it first.
 */
@Component
struct FileListRow {
  colors: AAColors = AA_LIGHT_COLORS;
  name: string = '';
  iconCommands: string = '';
  copyPath: string = '';
  menuOpen: boolean = false;
  trailingChevron: boolean = false;
  /** True for 180ms after a tap, when the surface flashes. */
  flash: boolean = false;
  onOpenMenu: () => void = () => {};
  onDismissMenu: () => void = () => {};
  onCopyPath: (value: string) => void = () => {};
  onTap: () => void = () => {};
  @State private pressed: boolean = false;
  @State private menuOffsetX: number = 54;
  @State private menuOffsetY: number = 56;

  private active(): boolean {
    return this.pressed || this.flash;
  }

  build() {
    Row({ space: 12 }) {
      Column() {
        AAIcon({
          commands: this.iconCommands,
          iconSize: 22,
          color: this.colors.isDark ? '#A1A1AA' : '#2F302D',
        })
      }
      .width(40)
      .height(40)
      .justifyContent(FlexAlign.Center)
      .borderRadius(12)

      Text(this.name)
        .fontSize(15)
        .lineHeight(20)
        .fontWeight(600)
        .fontColor(this.colors.isDark ? '#FAFAFA' : '#242521')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      if (this.trailingChevron) {
        AAIcon({
          commands: AA_ICONS.CHEVRON_RIGHT,
          iconSize: 20,
          color: this.colors.isDark ? '#71717A' : '#A8A6A0',
        })
      }
    }
    .width('100%')
    .height(60)
    .padding({ left: 10, right: 10 })
    .borderRadius(16)
    .backgroundColor(this.active()
      ? (this.colors.isDark ? this.colors.subtle : '#EDEBE6')
      : '#00000000')
    .shadow(this.active()
      ? {
        radius: 14,
        color: this.colors.isDark ? '#77000000' : '#30000000',
        offsetX: 0,
        offsetY: 4,
      }
      : { radius: 0, color: '#00000000', offsetX: 0, offsetY: 0 })
    .alignItems(VerticalAlign.Center)
    .gesture(
      LongPressGesture()
        .onAction(() => {
          this.onOpenMenu();
        }),
    )
    .bindMenu(this.menuOpen, this.CopyPathMenu(), {
      placement: Placement.TopLeft,
      enableArrow: false,
      onDisappear: () => {
        this.onDismissMenu();
      },
    })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressed = true;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
    .onClick(() => {
      this.onDismissMenu();
      this.onTap();
    })
  }

  /** Android's `FileActionMenu`: 188x54, a 32dp circular icon and a label. */
  @Builder
  CopyPathMenu() {
    Row({ space: 12 }) {
      Column() {
        AAIcon({
          commands: AA_ICONS.COPY,
          iconSize: 17,
          color: this.colors.isDark ? '#F4F4F5' : '#2F302D',
        })
      }
      .width(32)
      .height(32)
      .justifyContent(FlexAlign.Center)
      .borderRadius(16)
      .backgroundColor(this.colors.isDark ? '#3A3A3D' : '#F1F1EF')

      Text($r('app.string.files_copy_path'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(this.colors.isDark ? '#F4F4F5' : '#2F302D')
        .maxLines(1)
    }
    .width(188)
    .height(54)
    .padding({ left: 12, right: 12 })
    .borderRadius(16)
    .backgroundColor(this.colors.isDark ? '#202023' : '#FFFFFF')
    .border({
      width: 1,
      color: this.colors.isDark ? '#38383C' : '#EFEDE9',
    })
    .shadow({
      radius: 24,
      color: this.colors.isDark ? '#80000000' : '#1A000000',
      offsetX: 0,
      offsetY: 4,
    })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onCopyPath(this.copyPath))
  }
}

/**
 * The icon for a file name.
 *
 * Android's `fileIconFor`, with the same special cases: dotenv files and anything
 * named like a secret get the key glyph, JSON gets braces, markdown and text get a
 * text glyph, and a name the language table knows becomes a code glyph.
 */
function fileIconFor(name: string): string {
  const lower: string = name.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.') || lower.includes('secret')) {
    return AA_ICONS.KEY_ROUND;
  }
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
    return AA_ICONS.BRACES;
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
    return AA_ICONS.FILE_TEXT;
  }
  return AA_ICONS.FILE_CODE;
}
