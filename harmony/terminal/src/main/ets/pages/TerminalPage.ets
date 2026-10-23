import { buffer } from '@kit.ArkTS';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { wantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ApiClient } from 'network';
import { DevicesApi, RemoteDevice } from 'network';
import { RealtimeSocketListener, RealtimeWebSocket } from 'network';
import { SharedApiClient } from 'session';
import { RemoteTerminal, TerminalApi } from 'network';
import { AuthSessionStore } from 'session';
import { errorMessageFrom } from 'common';
import { NetworkMonitor } from 'common';
import { objGetOptNumber, objGetString, parseJsonRecord } from 'common';
import { TerminalEmulator } from '../common/TerminalEmulator';
import { TerminalChunkDataSource, TerminalChunkRow, TerminalRenderBuilder, TerminalSegment } from '../common/TerminalRender';
import { APP_IS_DARK_KEY, getColors } from 'common';

const TERMINAL_LABEL_PREFIX = 'HMOS ';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_SCROLLBACK_LINES = 2000;
const MAX_PENDING_INPUT = 64;
const TERMINAL_FONT_SIZE = 12;
const PROBE_CHAR_COUNT = 40;
const PROBE_TEXT = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
const LOG_TAG = 'TerminalPage';
const KEEP_ALIVE_BUNDLE = 'com.agentsanywhere.app';
const KEEP_ALIVE_ABILITY = 'EntryAbility';

interface DeviceOption {
  value: string;
  icon?: Resource;
}

// Toolbar shortcut definitions; mirrors android's TerminalShortcut set plus
// dedicated Ctrl+C / Ctrl+D / Ctrl+L keys.
class TerminalShortcutDef {
  label: string;
  kind: string;

  constructor(label: string, kind: string) {
    this.label = label;
    this.kind = kind;
  }
}

const SHORTCUTS: TerminalShortcutDef[] = [
  new TerminalShortcutDef('ESC', 'esc'),
  new TerminalShortcutDef('/', 'slash'),
  new TerminalShortcutDef('-', 'dash'),
  new TerminalShortcutDef('HOME', 'home'),
  new TerminalShortcutDef('↑', 'up'),
  new TerminalShortcutDef('END', 'end'),
  new TerminalShortcutDef('PGUP', 'pageup'),
  new TerminalShortcutDef('TAB', 'tab'),
  new TerminalShortcutDef('CTRL', 'ctrl'),
  new TerminalShortcutDef('ALT', 'alt'),
  new TerminalShortcutDef('←', 'left'),
  new TerminalShortcutDef('↓', 'down'),
  new TerminalShortcutDef('→', 'right'),
  new TerminalShortcutDef('PGDN', 'pagedown'),
  new TerminalShortcutDef('^C', 'ctrlc'),
  new TerminalShortcutDef('^D', 'ctrld'),
  new TerminalShortcutDef('^L', 'ctrll')
];

function encodeBase64Utf8(text: string): string {
  return buffer.from(text, 'utf-8').toString('base64');
}

function decodeBase64Utf8(text: string): string {
  return buffer.from(text, 'base64').toString('utf-8');
}

// Mirrors android RemoteTerminalController.controlCodePoint.
function controlCodePoint(code: number): number {
  if (code >= 'a'.charCodeAt(0) && code <= 'z'.charCodeAt(0)) {
    return code - 'a'.charCodeAt(0) + 1;
  }
  if (code >= 'A'.charCodeAt(0) && code <= 'Z'.charCodeAt(0)) {
    return code - 'A'.charCodeAt(0) + 1;
  }
  if (code === ' '.charCodeAt(0) || code === '2'.charCodeAt(0)) {
    return 0;
  }
  if (code === '['.charCodeAt(0) || code === '3'.charCodeAt(0)) {
    return 27;
  }
  if (code === '\\'.charCodeAt(0) || code === '4'.charCodeAt(0)) {
    return 28;
  }
  if (code === ']'.charCodeAt(0) || code === '5'.charCodeAt(0)) {
    return 29;
  }
  if (code === '^'.charCodeAt(0) || code === '6'.charCodeAt(0)) {
    return 30;
  }
  if (code === '_'.charCodeAt(0) || code === '7'.charCodeAt(0) || code === '/'.charCodeAt(0)) {
    return 31;
  }
  return code;
}

@Component
export struct TerminalPage {
  @StorageProp(APP_IS_DARK_KEY) @Watch('onThemeChanged') themeIsDark: boolean = false;
  @State loading: boolean = true;
  @State errorMessage: string = '';
  @State devices: RemoteDevice[] = [];
  @State deviceOptions: DeviceOption[] = [];
  @State selectedDeviceIndex: number = 0;
  @State deviceId: string = '';
  @State terminalLabel: string = '';
  @State renderLineCount: number = 0;
  @State connected: boolean = false;
  @State exited: boolean = false;
  @State inputText: string = '';
  @State connecting: boolean = false;
  @State terminalCols: number = DEFAULT_COLS;
  @State terminalRows: number = DEFAULT_ROWS;
  @State pendingCount: number = 0;
  @State ctrlLatched: boolean = false;
  @State altLatched: boolean = false;
  @State followBottom: boolean = true;
  private terminal: RemoteTerminal | null = null;
  private emulator: TerminalEmulator = new TerminalEmulator(DEFAULT_COLS, DEFAULT_ROWS, MAX_SCROLLBACK_LINES);
  private renderBuilder: TerminalRenderBuilder = new TerminalRenderBuilder();
  private dataSource: TerminalChunkDataSource = new TerminalChunkDataSource();
  private renderSeq: number = 0;
  private hasOutput: boolean = false;
  private charWidth: number = 0;
  private terminalWidth: number = 0;
  private chunkCols: number = DEFAULT_COLS;
  private keepAliveStarted: boolean = false;
  private lastSeq: number = 0;
  private pendingInput: string[] = [];
  private lastSentResize: string = '';
  private ephemeralGroupId: string = `hmos_${Date.now().toString(36)}`;
  private optCounter: number = 0;
  private navPathStack: NavPathStack = new NavPathStack();
  private scroller: Scroller = new Scroller();
  private socket: RealtimeWebSocket = new RealtimeWebSocket();
  private networkMonitor: NetworkMonitor = new NetworkMonitor();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private terminalApi: TerminalApi = new TerminalApi(this.client);
  private resizeDebounce: number = -1;

  aboutToDisappear(): void {
    this.networkMonitor.stop();
    this.socket.destroy();
    if (this.resizeDebounce >= 0) {
      clearTimeout(this.resizeDebounce);
      this.resizeDebounce = -1;
    }
    this.stopKeepAlive();
    this.closeOwnedTerminal();
  }

  private closeOwnedTerminal(): void {
    const terminal = this.terminal;
    if (terminal === null || this.deviceId.length === 0) {
      return;
    }
    if (terminal.label.indexOf(TERMINAL_LABEL_PREFIX) !== 0) {
      return;
    }
    this.terminalApi.closeTerminal(this.serverUrl(), this.token(), this.deviceId, terminal.terminalId)
      .catch(() => {
      });
  }

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private nextId(): string {
    this.optCounter++;
    return `${this.ephemeralGroupId}_${this.optCounter}`;
  }

  // --- Rendering ---

  private refreshScreen(): void {
    this.renderSeq++;
    const colors = getColors();
    const rows = this.renderBuilder.buildRows(this.emulator, this.chunkCols,
      colors.terminalText, colors.terminalBackground,
      !this.exited && this.emulator.isCursorVisible(), this.renderSeq);
    this.dataSource.reload(rows);
    this.renderLineCount = this.hasOutput ? rows.length : 0;
    this.pendingCount = this.pendingInput.length;
    this.scheduleFollowBottom();
  }

  private scheduleFollowBottom(): void {
    if (!this.followBottom) {
      return;
    }
    setTimeout(() => {
      if (!this.followBottom) {
        return;
      }
      const count = this.dataSource.totalCount();
      if (count > 0) {
        this.scroller.scrollToIndex(count - 1, false, ScrollAlign.END);
      }
    }, 60);
  }

  private scrollToBottom(): void {
    this.followBottom = true;
    const count = this.dataSource.totalCount();
    if (count > 0) {
      this.scroller.scrollToIndex(count - 1, true, ScrollAlign.END);
    }
  }

  private handleScrollIndex(start: number, end: number, center: number): void {
    const count = this.dataSource.totalCount();
    if (count === 0) {
      return;
    }
    this.followBottom = end >= count - 1;
  }

  private onThemeChanged(): void {
    this.refreshScreen();
  }

  private handleProbeWidth(area: Area): void {
    const width = area.width;
    if (typeof width === 'number' && width > 0) {
      this.charWidth = width / PROBE_CHAR_COUNT;
      this.recomputeChunkCols();
    }
  }

  private handleTerminalWidth(area: Area): void {
    const width = area.width;
    if (typeof width === 'number' && width > 0) {
      this.terminalWidth = width;
      this.recomputeChunkCols();
    }
  }

  private recomputeChunkCols(): void {
    if (this.charWidth <= 0 || this.terminalWidth <= 0) {
      return;
    }
    const usable = this.terminalWidth - 16; // List horizontal padding (8 + 8)
    let cols = Math.floor(usable / this.charWidth);
    if (cols < 16) {
      cols = 16;
    }
    if (cols !== this.chunkCols) {
      this.chunkCols = cols;
      this.refreshScreen();
    }
  }

  private appendOutput(chunk: string): void {
    this.hasOutput = true;
    this.emulator.feed(chunk);
    this.refreshScreen();
  }

  // --- Keep-alive (continuous task) ---

  private async startKeepAlive(): Promise<void> {
    if (this.keepAliveStarted) {
      return;
    }
    try {
      const wantAgentInfo: wantAgent.WantAgentInfo = {
        wants: [{
          bundleName: KEEP_ALIVE_BUNDLE,
          abilityName: KEEP_ALIVE_ABILITY
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0
      };
      const agent = await wantAgent.getWantAgent(wantAgentInfo);
      await backgroundTaskManager.startBackgroundRunning(getContext(this),
        backgroundTaskManager.BackgroundMode.DATA_TRANSFER, agent);
      this.keepAliveStarted = true;
      hilog.info(0x0000, LOG_TAG, 'terminal keep-alive started');
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(0x0000, LOG_TAG, `terminal keep-alive unavailable: ${err.code} ${err.message}`);
    }
  }

  private async stopKeepAlive(): Promise<void> {
    if (!this.keepAliveStarted) {
      return;
    }
    this.keepAliveStarted = false;
    try {
      await backgroundTaskManager.stopBackgroundRunning(getContext(this));
      hilog.info(0x0000, LOG_TAG, 'terminal keep-alive stopped');
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(0x0000, LOG_TAG, `terminal keep-alive stop failed: ${err.code} ${err.message}`);
    }
  }

  // --- Connection lifecycle ---

  private async pickDevice(): Promise<void> {
    const devices = await this.devicesApi.listDevices(this.serverUrl(), this.token());
    if (devices.length === 0) {
      this.devices = [];
      this.deviceOptions = [];
      this.errorMessage = 'No devices paired yet.';
      this.loading = false;
      return;
    }
    let selectedIndex = 0;
    for (let index = 0; index < devices.length; index++) {
      if (devices[index].status === 'online') {
        selectedIndex = index;
        break;
      }
    }
    this.devices = devices;
    const options: DeviceOption[] = [];
    for (const device of devices) {
      options.push({ value: device.name });
    }
    this.deviceOptions = options;
    this.selectedDeviceIndex = selectedIndex;
    this.deviceId = devices[selectedIndex].id;
  }

  private async startTerminal(): Promise<void> {
    this.connecting = true;
    this.errorMessage = '';
    try {
      if (this.deviceId.length === 0) {
        await this.pickDevice();
      }
      if (this.deviceId.length === 0) {
        this.connecting = false;
        return;
      }
      const terminal = await this.acquireTerminal();
      this.terminal = terminal;
      this.terminalLabel = terminal.label;
      this.terminalCols = terminal.cols;
      this.terminalRows = terminal.rows;
      this.emulator.resize(terminal.cols, terminal.rows);
      this.connectStream(0);
      this.startKeepAlive();
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.connecting = false;
    this.loading = false;
  }

  private async acquireTerminal(): Promise<RemoteTerminal> {
    const terminals = await this.terminalApi.listTerminals(this.serverUrl(), this.token(), this.deviceId);
    for (const terminal of terminals) {
      if (terminal.status !== 'exited' && terminal.label.indexOf(TERMINAL_LABEL_PREFIX) === 0) {
        return terminal;
      }
    }
    return this.terminalApi.createTerminal(this.serverUrl(), this.token(), this.deviceId, '~',
      DEFAULT_COLS, DEFAULT_ROWS, '.', this.ephemeralGroupId, `${TERMINAL_LABEL_PREFIX}Terminal`);
  }

  private connectStream(fromSeq: number): void {
    const terminal = this.terminal;
    if (terminal === null) {
      return;
    }
    this.socket.destroy();
    const url = this.terminalApi.streamUrl(this.serverUrl(), this.deviceId, terminal.terminalId, fromSeq);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token()}`
    };
    this.socket.connect(url, this.createSocketListener(), headers);
  }

  private createSocketListener(): RealtimeSocketListener {
    const listener: RealtimeSocketListener = {
      onOpen: (): void => {
        this.connected = true;
        this.errorMessage = '';
        this.sendPendingResize();
        this.flushPendingInput();
      },
      onMessage: (text: string): void => {
        this.handleFrame(text);
      },
      onClose: (code: number, reason: string): void => {
        this.connected = false;
        this.scheduleReconnect();
      },
      onError: (message: string): void => {
        this.connected = false;
        this.errorMessage = message;
        this.scheduleReconnect();
      }
    };
    return listener;
  }

  private scheduleReconnect(): void {
    if (this.exited) {
      return;
    }
    setTimeout(() => {
      this.connectStream(this.lastSeq);
    }, 1000);
  }

  /**
   * Connectivity just returned: reconnect the terminal stream immediately when
   * it is down, instead of waiting for the next 1s retry tick.
   */
  private onNetworkRestored(): void {
    if (this.exited || this.connected) {
      return;
    }
    this.connectStream(this.lastSeq);
  }

  private handleFrame(text: string): void {
    let frame: Record<string, Object>;
    try {
      frame = parseJsonRecord(text);
    } catch (error) {
      return;
    }
    const type = objGetString(frame, 'type', '');
    if (type === 'output' || type === 'replay') {
      const data = objGetString(frame, 'data', '');
      if (data.length === 0) {
        return;
      }
      const seq = objGetOptNumber(frame, 'seq');
      if (seq !== null && seq > 0 && seq <= this.lastSeq) {
        return;
      }
      if (seq !== null && seq > this.lastSeq) {
        this.lastSeq = seq;
      }
      if (type === 'replay') {
        this.emulator.reset();
      }
      this.appendOutput(decodeBase64Utf8(data));
      return;
    }
    if (type === 'exit') {
      this.exited = true;
      this.connected = false;
      this.pendingInput = [];
      this.clearLatches();
      this.appendOutput('\n[process exited]\n');
      this.stopKeepAlive();
      return;
    }
    if (type === 'error') {
      this.errorMessage = objGetString(frame, 'message', 'Terminal error.');
    }
  }

  private sendPendingResize(): void {
    const key = `${this.terminalCols}x${this.terminalRows}`;
    if (key === this.lastSentResize) {
      return;
    }
    const frame = this.terminalApi.resizeFrame(this.terminalCols, this.terminalRows);
    this.socket.send(frame).catch(() => {
    });
    this.lastSentResize = key;
  }

  private requestTerminalResize(cols: number, rows: number): void {
    this.terminalCols = cols;
    this.terminalRows = rows;
    this.emulator.resize(cols, rows);
    this.refreshScreen();
    // Debounce resize frames the same way android's sendRemoteResizeNow does.
    if (this.resizeDebounce >= 0) {
      clearTimeout(this.resizeDebounce);
    }
    this.resizeDebounce = setTimeout(() => {
      this.resizeDebounce = -1;
      this.sendPendingResize();
      this.flushPendingInput();
    }, 160);
  }

  // --- Input ---

  private sendInput(): void {
    const text = this.inputText;
    if (text.length === 0 || this.exited) {
      return;
    }
    let data = text;
    let echo = true;
    if (this.ctrlLatched) {
      const first = text.substring(0, 1);
      data = String.fromCharCode(controlCodePoint(first.charCodeAt(0)));
      echo = false;
    } else if (this.altLatched) {
      data = `\u001b${text}`;
      echo = false;
    }
    this.clearLatches();
    const payload = this.terminalApi.inputFrame(encodeBase64Utf8(data));
    const sendResult = this.socket.send(payload);
    if (!this.connected) {
      this.queueInput(data);
    } else {
      sendResult.catch(() => {
        this.queueInput(data);
      });
    }
    this.inputText = '';
    if (echo) {
      this.appendOutput(`${text}\n`);
    }
  }

  private sendRawText(text: string): void {
    if (text.length === 0 || this.exited) {
      return;
    }
    this.clearLatches();
    const payload = this.terminalApi.inputFrame(encodeBase64Utf8(text));
    const sendResult = this.socket.send(payload);
    if (!this.connected) {
      this.queueInput(text);
    } else {
      sendResult.catch(() => {
        this.queueInput(text);
      });
    }
  }

  private queueInput(text: string): void {
    if (this.pendingInput.length >= MAX_PENDING_INPUT) {
      this.pendingInput.shift();
    }
    this.pendingInput.push(text);
    this.refreshScreen();
  }

  private flushPendingInput(): void {
    if (this.pendingInput.length === 0) {
      return;
    }
    const queued = this.pendingInput.slice(0);
    this.pendingInput = [];
    for (const text of queued) {
      const payload = this.terminalApi.inputFrame(encodeBase64Utf8(text));
      this.socket.send(payload).catch(() => {
        this.queueInput(text);
      });
    }
    this.refreshScreen();
  }

  private clearLatches(): void {
    this.ctrlLatched = false;
    this.altLatched = false;
  }

  // --- Shortcut toolbar ---

  private handleShortcut(kind: string): void {
    if (this.exited) {
      return;
    }
    if (kind === 'ctrl') {
      this.ctrlLatched = !this.ctrlLatched;
      if (this.ctrlLatched) {
        this.altLatched = false;
      }
      return;
    }
    if (kind === 'alt') {
      this.altLatched = !this.altLatched;
      if (this.altLatched) {
        this.ctrlLatched = false;
      }
      return;
    }
    if (kind === 'esc') {
      this.sendRawText('\u001b');
      return;
    }
    if (kind === 'tab') {
      this.sendRawText('\t');
      return;
    }
    if (kind === 'slash') {
      this.sendRawText('/');
      return;
    }
    if (kind === 'dash') {
      this.sendRawText('-');
      return;
    }
    if (kind === 'ctrlc') {
      this.sendRawText('\u0003');
      return;
    }
    if (kind === 'ctrld') {
      this.sendRawText('\u0004');
      return;
    }
    if (kind === 'ctrll') {
      this.sendRawText('\u000c');
      return;
    }
    const sequence = this.navigationSequence(kind);
    if (sequence.length > 0) {
      this.sendRawText(sequence);
    }
  }

  // ANSI escape sequence for navigation keys, honoring latched modifiers the
  // way android's KeyHandler does (modifier 1=none, 3=alt, 5=ctrl, 7=both).
  private navigationSequence(kind: string): string {
    let letter = '';
    let tilde = 0;
    if (kind === 'up') {
      letter = 'A';
    } else if (kind === 'down') {
      letter = 'B';
    } else if (kind === 'right') {
      letter = 'C';
    } else if (kind === 'left') {
      letter = 'D';
    } else if (kind === 'home') {
      letter = 'H';
    } else if (kind === 'end') {
      letter = 'F';
    } else if (kind === 'pageup') {
      tilde = 5;
    } else if (kind === 'pagedown') {
      tilde = 6;
    } else {
      return '';
    }
    const modifier = 1 + (this.altLatched ? 2 : 0) + (this.ctrlLatched ? 4 : 0);
    if (tilde > 0) {
      return modifier > 1 ? `\u001b[${tilde};${modifier}~` : `\u001b[${tilde}~`;
    }
    return modifier > 1 ? `\u001b[1;${modifier}${letter}` : `\u001b[${letter}`;
  }

  private shortcutLabelColor(shortcut: TerminalShortcutDef): string {
    if (this.isShortcutActive(shortcut)) {
      return this.themeIsDark ? '#67E8F9' : '#0891B2';
    }
    return this.themeIsDark ? '#FAFAFA' : '#151515';
  }

  private shortcutSurfaceColor(shortcut: TerminalShortcutDef): string {
    if (this.isShortcutActive(shortcut)) {
      return this.themeIsDark ? '#1A67E8F9' : '#1A0891B2';
    }
    return 'transparent';
  }

  private isShortcutActive(shortcut: TerminalShortcutDef): boolean {
    return (shortcut.kind === 'ctrl' && this.ctrlLatched) || (shortcut.kind === 'alt' && this.altLatched);
  }

  private clearBackground(): string {
    return this.themeIsDark ? 'rgba(24,24,27,0.87)' : 'rgba(255,255,255,0.93)';
  }

  private clearBorder(): string {
    return this.themeIsDark ? '#3F3F46' : '#E7E5E0';
  }

  private clearIconColor(): string {
    if (this.connected && !this.exited) {
      return this.themeIsDark ? getColors().errorIcon : getColors().errorText;
    }
    return this.themeIsDark ? '#71717A' : '#A7A5A0';
  }

  // --- Misc ---

  private reconnect(): void {
    if (this.connecting) {
      return;
    }
    this.connectStream(this.lastSeq);
  }

  private async reopenTerminal(): Promise<void> {
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    this.errorMessage = '';
    this.exited = false;
    this.socket.destroy();
    this.terminal = null;
    this.terminalLabel = '';
    this.lastSeq = 0;
    this.pendingInput = [];
    this.emulator.reset();
    try {
      const terminal = await this.acquireTerminal();
      this.terminal = terminal;
      this.terminalLabel = terminal.label;
      this.terminalCols = terminal.cols;
      this.terminalRows = terminal.rows;
      this.emulator.resize(terminal.cols, terminal.rows);
      this.connectStream(0);
      this.refreshScreen();
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.connecting = false;
    this.loading = false;
  }

  private adjustRows(delta: number): void {
    const next = this.terminalRows + delta;
    if (next < 4 || next > 200) {
      return;
    }
    this.requestTerminalResize(this.terminalCols, next);
  }

  private clearTerminal(): void {
    this.emulator.clearScreen();
    this.refreshScreen();
  }

  private adjustCols(delta: number): void {
    const next = this.terminalCols + delta;
    if (next < 20 || next > 200) {
      return;
    }
    this.requestTerminalResize(next, this.terminalRows);
  }

  private statusText(): string {
    if (this.exited) {
      return 'exited';
    }
    if (this.connected) {
      return 'connected';
    }
    return 'disconnected';
  }

  private emptyStateText(): string {
    return this.connecting ? 'Connecting to terminal…' : 'Terminal is ready. Type a command below.';
  }

  private inputPlaceholder(): string {
    return this.exited ? 'Terminal exited' : 'Type a command…';
  }

  private statusColor(): string {
    if (this.exited) {
      return getColors().faint;
    }
    if (this.connected) {
      return getColors().noticeSuccess;
    }
    return getColors().noticeWarning;
  }

  private sendButtonLabel(): string {
    if (this.connected && !this.exited) {
      return 'Send';
    }
    return 'Reconnect';
  }

  @Builder
  toolButton(label: string, onPress: () => void, enabled: boolean) {
    Button(label)
      .fontSize(13)
      .height(28)
      .padding({ left: 10, right: 10 })
      .backgroundColor(getColors().raisedSurface)
      .fontColor(enabled ? getColors().inkSoft : getColors().faint)
      .enabled(enabled)
      .onClick(onPress)
  }

  build() {
    NavDestination() {
      Column() {
        if (this.deviceOptions.length > 1) {
          Row({ space: 8 }) {
            Text($r('app.string.files_device'))
              .fontSize(13)
              .fontColor(getColors().muted)
            Select(this.deviceOptions)
              .selected(this.selectedDeviceIndex)
              .value(this.deviceOptions[this.selectedDeviceIndex].value)
              .font({ size: 13 })
              .onSelect((index: number) => {
                this.handleDeviceChange(index);
              })
              .layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 4 })
        }
        Row({ space: 6 }) {
          Circle()
            .width(8)
            .height(8)
            .fill(this.statusColor())
          Text(this.statusText())
            .fontSize(12)
            .fontColor(this.statusColor())
          Text(this.terminalLabel)
            .fontSize(12)
            .fontColor(getColors().faint)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text(`${this.terminalCols}×${this.terminalRows}`)
            .fontSize(11)
            .fontColor(getColors().faint)
          this.toolButton('−', (): void => {
            this.adjustRows(-2);
          }, !this.exited)
          this.toolButton('+', (): void => {
            this.adjustRows(2);
          }, !this.exited)
          this.toolButton('⟳', (): void => {
            this.reconnect();
          }, !this.exited)
          Button() {
            SymbolGlyph($r('sys.symbol.trash'))
              .fontSize(17)
              .fontColor([this.clearIconColor()])
          }
          .fontSize(13)
          .height(34)
          .width(34)
          .borderRadius(17)
          .padding(0)
          .backgroundColor(this.clearBackground())
          .border({ width: 1, color: this.clearBorder() })
          .enabled(this.connected && !this.exited)
          .onClick(() => {
            this.clearTerminal();
          })
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 4 })
        if (this.pendingCount > 0) {
          Text($r('app.string.terminal_reconnecting', this.pendingCount))
            .fontSize(11)
            .fontColor(getColors().noticeWarning)
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
        Stack({ alignContent: Alignment.BottomEnd }) {
          List({ scroller: this.scroller }) {
            LazyForEach(this.dataSource, (row: TerminalChunkRow) => {
              ListItem() {
                Row() {
                  ForEach(row.segments, (seg: TerminalSegment) => {
                    Text(seg.text)
                      .fontSize(TERMINAL_FONT_SIZE)
                      .fontFamily('monospace')
                      .fontColor(seg.fg)
                      .backgroundColor(seg.bg)
                      .fontWeight(seg.bold ? FontWeight.Bold : FontWeight.Normal)
                  }, (seg: TerminalSegment, segIndex: number) => `${row.key}_${segIndex}_${seg.fg}_${seg.bg}_${seg.bold}`)
                }
                .width('100%')
                .alignItems(VerticalAlign.Top)
              }
            }, (row: TerminalChunkRow) => row.key)
          }
          .width('100%')
          .height('100%')
          .backgroundColor(getColors().terminalBackground)
          .padding({ left: 8, right: 8, top: 8, bottom: 8 })
          .cachedCount(6)
          .onScrollIndex((start: number, end: number, center: number) => {
            this.handleScrollIndex(start, end, center);
          })
          .onAreaChange((oldValue: Area, newValue: Area) => {
            this.handleTerminalWidth(newValue);
          })

          Text(PROBE_TEXT)
            .fontSize(TERMINAL_FONT_SIZE)
            .fontFamily('monospace')
            .maxLines(1)
            .opacity(0)
            .hitTestBehavior(HitTestMode.None)
            .position({ x: 0, y: 0 })
            .onAreaChange((oldValue: Area, newValue: Area) => {
              this.handleProbeWidth(newValue);
            })

          if (this.renderLineCount === 0) {
            Column() {
              if (this.loading) {
                LoadingProgress()
                  .width(44)
                  .height(44)
              } else {
                Text(this.emptyStateText())
                  .fontSize(13)
                  .fontColor(getColors().faint)
              }
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
          }

          if (this.renderLineCount > 0 && !this.followBottom) {
            Button($r('app.string.terminal_back_to_bottom'))
              .fontSize(12)
              .height(32)
              .padding({ left: 12, right: 12 })
              .margin(12)
              .backgroundColor(getColors().raisedSurface)
              .fontColor(getColors().ink)
              .onClick(() => {
                this.scrollToBottom();
              })
          }
        }
        .width('100%')
        .layoutWeight(1)

        Scroll() {
          Row({ space: 6 }) {
            ForEach(SHORTCUTS, (shortcut: TerminalShortcutDef) => {
              Text(shortcut.label)
                .fontSize(14)
                .fontWeight(500)
                .fontColor(this.shortcutLabelColor(shortcut))
                .backgroundColor(this.shortcutSurfaceColor(shortcut))
                .height(34)
                .padding({ left: 12, right: 12 })
                .borderRadius(8)
                .textAlign(TextAlign.Center)
                .enabled(!this.exited)
                .onClick(() => {
                  this.handleShortcut(shortcut.kind);
                })
            }, (shortcut: TerminalShortcutDef) => shortcut.kind)
          }
          .padding({ left: 12, right: 12 })
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .width('100%')
        .margin({ top: 6 })

        if (this.exited) {
          Button($r('app.string.terminal_reopen'))
            .fontSize(13)
            .height(36)
            .width('100%')
            .margin({ left: 12, right: 12, top: 8 })
            .backgroundColor(getColors().sessionStatusAccent)
            .fontColor(getColors().onPrimaryAction)
            .enabled(!this.connecting)
            .onClick(() => {
              this.reopenTerminal();
            })
        }
        Row({ space: 8 }) {
          TextInput({ text: this.inputText, placeholder: this.inputPlaceholder() })
            .fontSize(13)
            .height(40)
            .layoutWeight(1)
            .backgroundColor(getColors().matchedAccountSurface)
            .enabled(!this.exited)
            .onChange((value: string) => {
              this.inputText = value;
            })
            .onSubmit(() => {
              this.handlePrimaryAction();
            })
          Button(this.sendButtonLabel())
            .fontSize(13)
            .height(40)
            .padding({ left: 16, right: 16 })
            .backgroundColor(getColors().primaryAction)
            .fontColor(getColors().onPrimaryAction)
            .onClick(() => {
              this.handlePrimaryAction();
            })
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 8, bottom: 12 })
      }
      .width('100%')
      .height('100%')
    }
    .title($r('app.string.terminal_title'))
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      const raw = ctx.pathInfo.param as string;
      if (typeof raw === 'string' && raw.length > 0) {
        this.deviceId = raw;
      }
      this.networkMonitor.start({
        onNetworkAvailable: (): void => {
          this.onNetworkRestored();
        }
      });
      this.startTerminal();
    })
  }

  private handleDeviceChange(index: number): void {
    if (index < 0 || index >= this.devices.length) {
      return;
    }
    this.selectedDeviceIndex = index;
    this.deviceId = this.devices[index].id;
    this.terminal = null;
    this.terminalLabel = '';
    this.lastSeq = 0;
    this.exited = false;
    this.pendingInput = [];
    this.socket.destroy();
    this.startTerminal();
  }

  private handlePrimaryAction(): void {
    if (this.connected && !this.exited) {
      this.sendInput();
    } else {
      this.reconnect();
    }
  }
}

@Builder
export function TerminalPageBuilder() {
  TerminalPage()
}
