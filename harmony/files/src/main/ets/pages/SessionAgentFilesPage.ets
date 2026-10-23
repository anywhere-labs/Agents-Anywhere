import { ApiClient } from 'network';
import { FilesApi, RemoteAgentFileDownload, RemoteDirectoryEntry, RemoteTextFile } from 'network';
import { RemoteSessionResponse } from 'network';
import { SessionsApi } from 'network';
import { SharedApiClient } from 'session';
import { AuthSessionStore } from 'session';
import { errorMessageFrom } from 'common';
import {
  FilePreviewLine,
  FilePreviewLineDataSource,
  fileContentLines,
  fileEntryKind,
  fileEntrySymbol,
  fileEntrySymbolColor,
  findMatchLineIndexes
} from 'common';
import { FileRowMenuOverlay } from '../components/FileRowMenuOverlay';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { showToast } from 'common';
import { fileIo } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { pasteboard } from '@kit.BasicServicesKit';

// Mirrors Android SessionAgentFilesScreen: the session workspace root comes
// from session.cwd and browsing starts at "." inside that workspace.
const AGENT_START_PATH = '.';
// Same 25 MB cap the session attachment download path enforces.
const AGENT_MAX_DOWNLOAD_BYTES = 26214400;

function agentParentPath(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slashIndex < 0) {
    return AGENT_START_PATH;
  }
  const parent = path.substring(0, slashIndex);
  if (parent.length === 0) {
    return '/';
  }
  return parent;
}

function agentCanGoUp(path: string): boolean {
  return path !== AGENT_START_PATH && path !== '/' && path.length > 0;
}

function agentFormatSize(size: number | null): string {
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

/**
 * Agent files inside one session workspace (Android SessionAgentFilesScreen
 * parity). Directory navigation starts at the session cwd; files open as text
 * previews and any file can be saved locally through the fs/read transfer.
 */
@Component
export struct SessionAgentFilesPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State loading: boolean = true;
  @State refreshing: boolean = false;
  @State errorMessage: string = '';
  @State entries: RemoteDirectoryEntry[] = [];
  @State currentPath: string = AGENT_START_PATH;
  @State directoryTruncated: boolean = false;
  @State viewingFile: boolean = false;
  @State loadingFile: boolean = false;
  @State fileName: string = '';
  @State fileContent: string = '';
  @State fileSizeLabel: string = '';
  @State fileTruncated: boolean = false;
  @State fileBinary: boolean = false;
  @State savingFile: boolean = false;
  @State missingSession: boolean = false;
  @State noWorkspace: boolean = false;
  @State searchOpen: boolean = false;
  @State searchQuery: string = '';
  @State searchTotal: number = 0;
  @State searchCurrentOrdinal: number = 0;
  @State copiedContent: boolean = false;
  @State rowMenuOpen: boolean = false;
  @State rowMenuEntryName: string = '';
  private rowMenuEntryPath: string = '';
  private searchMatchLines: number[] = [];
  private searchCurrentIndex: number = 0;
  private copiedContentTimer: number = -1;
  private rawLines: string[] = [];
  private previewLines: FilePreviewLineDataSource = new FilePreviewLineDataSource();
  private sessionId: string = '';
  private connectorId: string = '';
  private workspaceRoot: string = '';
  private filePath: string = '';
  private navPathStack: NavPathStack = new NavPathStack();
  private scroller: Scroller = new Scroller();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private filesApi: FilesApi = new FilesApi(this.client);
  private sessionsApi: SessionsApi = new SessionsApi(this.client);

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private async start(): Promise<void> {
    if (this.sessionId.length === 0) {
      this.missingSession = true;
      this.loading = false;
      return;
    }
    try {
      const response: RemoteSessionResponse = await this.sessionsApi.getSessionMeta(this.serverUrl(),
        this.token(), this.sessionId);
      const cwd = response.session.cwd;
      this.connectorId = response.session.connectorId;
      this.workspaceRoot = cwd === null ? '' : cwd.trim();
      if (this.connectorId.length === 0 || this.workspaceRoot.length === 0) {
        this.noWorkspace = true;
        this.loading = false;
        return;
      }
      await this.loadDirectory(AGENT_START_PATH);
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
      this.loading = false;
    }
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

  private async loadDirectory(path: string): Promise<void> {
    if (this.connectorId.length === 0) {
      return;
    }
    try {
      const directory = await this.filesApi.listSessionAgentFiles(this.serverUrl(), this.token(),
        this.connectorId, this.workspaceRoot, path);
      this.entries = this.sortEntries(directory.entries);
      this.currentPath = directory.path.length > 0 ? directory.path : path;
      this.directoryTruncated = directory.truncated;
      this.errorMessage = '';
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.loading = false;
    this.refreshing = false;
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
      const file: RemoteTextFile = await this.filesApi.readSessionAgentTextFile(this.serverUrl(), this.token(),
        this.connectorId, this.workspaceRoot, entry.path);
      this.filePath = entry.path;
      this.fileName = file.name;
      this.fileContent = file.content;
      this.fileSizeLabel = agentFormatSize(file.size);
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
    if (agentCanGoUp(this.currentPath)) {
      this.loadDirectory(agentParentPath(this.currentPath));
    }
  }

  private closeViewer(): void {
    this.viewingFile = false;
    this.fileName = '';
    this.fileContent = '';
    this.fileTruncated = false;
    this.fileBinary = false;
    this.resetSearch();
  }

  private entryKindOf(entry: RemoteDirectoryEntry): string {
    return fileEntryKind(entry.name, entry.type === 'directory');
  }

  private entrySymbol(entry: RemoteDirectoryEntry): Resource {
    return fileEntrySymbol(this.entryKindOf(entry));
  }

  private entrySymbolColor(entry: RemoteDirectoryEntry): string {
    return fileEntrySymbolColor(this.entryKindOf(entry));
  }

  private entrySubtitle(entry: RemoteDirectoryEntry): string {
    const sizeLabel = agentFormatSize(entry.size);
    if (sizeLabel.length === 0) {
      return entry.type;
    }
    return `${entry.type} · ${sizeLabel}`;
  }

  private emptyStateText(): ResourceStr {
    return this.loading ? $r('app.string.session_agent_files_loading')
      : $r('app.string.session_agent_files_empty');
  }

  /**
   * Build the absolute URL for a server-relative transfer downloadUrl
   * (the fs/read response returns a path like /api/v2/connectors/...).
   */
  private absoluteDownloadUrl(downloadUrl: string): string {
    const base = this.serverUrl().replace(/\/+$/, '');
    return `${base}${downloadUrl}`;
  }

  /**
   * Open the system save picker so the user chooses where the file is
   * written. Returns null when the user cancels the picker.
   */
  private async pickSaveLocation(fileName: string): Promise<string | null> {
    const saveOptions: picker.DocumentSaveOptions = { newFileNames: [fileName] };
    const savePicker = new picker.DocumentViewPicker();
    try {
      const uris = await savePicker.save(saveOptions);
      if (uris.length === 0) {
        return null;
      }
      return uris[0];
    } catch (error) {
      // The save sheet rejects when the user cancels; treat any picker exit
      // as a cancel and stay silent.
      return null;
    }
  }

  /**
   * Download the currently previewed agent file through the fs/read transfer
   * and write it to a location chosen with the system save picker.
   */
  private async saveCurrentFile(): Promise<void> {
    if (this.savingFile || this.filePath.length === 0) {
      return;
    }
    this.savingFile = true;
    try {
      const download: RemoteAgentFileDownload = await this.filesApi.requestSessionAgentFileDownload(
        this.serverUrl(), this.token(), this.connectorId, this.workspaceRoot, this.filePath);
      if (download.downloadUrl.length === 0) {
        showToast($r('app.string.session_agent_files_save_failed'));
        this.savingFile = false;
        return;
      }
      const targetUri = await this.pickSaveLocation(this.fileName.length > 0 ? this.fileName : download.name);
      if (targetUri === null) {
        this.savingFile = false;
        return;
      }
      const fetched = await this.client.fetchUrlBytes(this.absoluteDownloadUrl(download.downloadUrl),
        AGENT_MAX_DOWNLOAD_BYTES);
      const file = await fileIo.open(targetUri, fileIo.OpenMode.READ_WRITE);
      try {
        const buffer = new ArrayBuffer(fetched.bytes.byteLength);
        new Uint8Array(buffer).set(fetched.bytes);
        await fileIo.write(file.fd, buffer);
      } finally {
        await fileIo.close(file.fd);
      }
      showToast($r('app.string.session_agent_files_saved'));
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
    }
    this.savingFile = false;
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

  build() {
    NavDestination() {
      Stack() {
        Column() {
          if (this.viewingFile) {
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
              if (this.savingFile) {
                LoadingProgress()
                  .width(18)
                  .height(18)
              } else {
                Button($r('app.string.session_agent_files_save'))
                  .fontSize(13)
                  .height(32)
                  .padding({ left: 12, right: 12 })
                  .backgroundColor(getColors().primaryAction)
                  .fontColor(getColors().onPrimaryAction)
                  .onClick(() => {
                    this.saveCurrentFile();
                  })
              }
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 4, bottom: 4 })
            if (!this.fileBinary) {
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
            }
            if (this.fileTruncated) {
              Text($r('app.string.session_agent_files_truncated_notice'))
                .fontSize(12)
                .fontColor(getColors().noticeWarning)
                .width('100%')
                .padding({ left: 16, right: 16 })
            }
            if (this.fileBinary) {
              Column() {
                Text($r('app.string.session_agent_files_binary'))
                  .fontSize(13)
                  .fontColor(getColors().faint)
                  .width('100%')
                  .textAlign(TextAlign.Center)
                  .padding({ top: 32, bottom: 32 })
              }
              .width('100%')
              .layoutWeight(1)
              .justifyContent(FlexAlign.Center)
            } else {
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
          } else {
            Row({ space: 8 }) {
              Button($r('app.string.files_up'))
                .fontSize(13)
                .height(32)
                .padding({ left: 12, right: 12 })
                .backgroundColor(getColors().raisedSurface)
                .fontColor(getColors().inkSoft)
                .enabled(agentCanGoUp(this.currentPath))
                .onClick(() => {
                  this.goUp();
                })
              Text(this.currentPath)
                .fontSize(13)
                .fontColor(getColors().muted)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Button('⟳')
                .fontSize(13)
                .height(32)
                .padding({ left: 10, right: 10 })
                .backgroundColor(getColors().raisedSurface)
                .fontColor(getColors().inkSoft)
                .onClick(() => {
                  this.loadDirectory(this.currentPath);
                })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 8, bottom: 4 })
            if (this.directoryTruncated) {
              Text($r('app.string.files_truncated'))
                .fontSize(12)
                .fontColor(getColors().noticeWarning)
                .width('100%')
                .padding({ left: 16, right: 16 })
            }
            if (this.missingSession) {
              Text($r('app.string.session_agent_files_missing_session'))
                .fontSize(12)
                .fontColor(getColors().errorText)
                .width('100%')
                .padding({ left: 16, right: 16 })
            }
            if (this.noWorkspace) {
              Text($r('app.string.session_agent_files_no_workspace'))
                .fontSize(12)
                .fontColor(getColors().errorText)
                .width('100%')
                .padding({ left: 16, right: 16 })
            }
            if (this.errorMessage.length > 0) {
              Text(this.errorMessage)
                .fontSize(12)
                .fontColor(getColors().errorText)
                .width('100%')
                .padding({ left: 16, right: 16 })
            }
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
                List({ space: 4 }) {
                  if (this.entries.length === 0) {
                    ListItem() {
                      Text(this.emptyStateText())
                        .fontSize(13)
                        .fontColor(getColors().faint)
                        .width('100%')
                        .textAlign(TextAlign.Center)
                        .padding({ top: 32, bottom: 32 })
                    }
                  }
                  ForEach(this.entries, (entry: RemoteDirectoryEntry) => {
                    ListItem() {
                      Row({ space: 10 }) {
                        SymbolGlyph(this.entrySymbol(entry))
                          .fontSize(20)
                          .fontColor([this.entrySymbolColor(entry)])
                        Column({ space: 2 }) {
                          Text(entry.name)
                            .fontSize(14)
                            .maxLines(1)
                            .textOverflow({ overflow: TextOverflow.Ellipsis })
                          Text(this.entrySubtitle(entry))
                            .fontSize(11)
                            .fontColor(getColors().faint)
                        }
                        .alignItems(HorizontalAlign.Start)
                        .layoutWeight(1)
                        if (this.loadingFile) {
                          LoadingProgress()
                            .width(16)
                            .height(16)
                        }
                      }
                      .width('100%')
                      .padding(10)
                      .borderRadius(10)
                      .backgroundColor(getColors().matchedAccountSurface)
                      .onClick(() => {
                        this.openEntry(entry);
                      })
                      .gesture(
                        LongPressGesture()
                          .onAction(() => {
                            this.openRowMenu(entry);
                          })
                      )
                    }
                  }, (entry: RemoteDirectoryEntry) => entry.path)
                }
                .width('100%')
                .layoutWeight(1)
                .padding({ left: 16, right: 16, top: 4, bottom: 16 })
              }
              .onRefreshing(() => {
                this.loadDirectory(this.currentPath);
              })
              .width('100%')
              .layoutWeight(1)
            }
          }
        }
        .width('100%')
        .height('100%')

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
    .title($r('app.string.session_agent_files'))
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      const raw = ctx.pathInfo.param as string;
      if (typeof raw === 'string' && raw.length > 0) {
        this.sessionId = raw;
      }
      this.start();
    })
  }
}

@Builder
export function SessionAgentFilesPageBuilder() {
  SessionAgentFilesPage()
}
