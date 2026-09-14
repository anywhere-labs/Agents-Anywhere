import { webview } from '@kit.ArkWeb';
import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AuthErrorNotice } from '../../designsystem/AAComponents';
import { AALog } from '../../../common/AAAppLog';
import { base64Encode } from '../../../common/AAEncoding';
import {
  RemoteTerminalController, RemoteTerminalStatus, RemoteTerminalState, TerminalModifierState,
  TerminalScreenSink,
} from '../../../feature/terminal/RemoteTerminalController';
import { TerminalShortcut, terminalShortcutLabel } from '../../../feature/terminal/TerminalKeys';
import { resolveString } from '../../../common/AAResources';

/**
 * The terminal surface.
 *
 * Port of `TerminalContent` in
 * `ui/screens/sessiondetail/SessionAgentFilesScreen.kt`.
 *
 * Android paints this with a native `RemoteTerminalView` fed by a Termux
 * emulator; this port paints it with xterm.js inside an ArkWeb page and forwards
 * the byte stream across a JavaScript bridge. The chrome around the terminal is
 * identical:
 *
 *  - a status line that becomes a blue-grey banner while connecting, a red error
 *    notice when the stream is closed, exited or failed, and a quiet monospace
 *    line otherwise;
 *  - a 34dp translucent trash button at the top right that drops the remote
 *    shell and starts a new one;
 *  - an 88dp two-row shortcut deck that only appears while the soft keyboard is
 *    up, with CTRL/ALT latching into the next key.
 */

/** The methods the page is allowed to call back into. */
const BRIDGE_METHODS: string[] = ['onData', 'onResize', 'onModes', 'onKeyboard', 'onReady'];

const TERMINAL_PAGE: string = 'terminal/index.html';

/**
 * The page half of the bridge.
 *
 * ArkWeb calls these on the registered proxy object; the handlers are assigned by
 * the screen so this class stays a plain transport.
 */
export class TerminalBridge {
  dataHandler: (text: string) => void = () => {};
  resizeHandler: (cols: number, rows: number) => void = () => {};
  modesHandler: (cursorApplication: boolean, keypadApplication: boolean) => void = () => {};
  keyboardHandler: (visible: boolean) => void = () => {};
  readyHandler: () => void = () => {};

  onData(text: string): void {
    this.dataHandler(text);
  }

  onResize(cols: number, rows: number): void {
    this.resizeHandler(cols, rows);
  }

  onModes(cursorApplication: boolean, keypadApplication: boolean): void {
    this.modesHandler(cursorApplication, keypadApplication);
  }

  onKeyboard(visible: boolean): void {
    this.keyboardHandler(visible);
  }

  onReady(): void {
    this.readyHandler();
  }
}

/**
 * Drives the terminal page.
 *
 * Scripts issued before the page has loaded are queued rather than dropped: the
 * controller starts producing output as soon as its socket opens, which can be
 * before ArkWeb has finished loading the page, and a terminal that silently lost
 * its first banner would look broken.
 */
export class TerminalWebSink implements TerminalScreenSink {
  private readonly web: webview.WebviewController;
  private ready: boolean = false;
  private queue: string[] = [];
  private target: RemoteTerminalController | null = null;

  constructor(web: webview.WebviewController) {
    this.web = web;
  }

  setTarget(controller: RemoteTerminalController | null): void {
    this.target = controller;
  }

  targetController(): RemoteTerminalController | null {
    return this.target;
  }

  /** The page finished loading; every queued script runs now, in order. */
  markReady(): void {
    if (this.ready) {
      return;
    }
    this.ready = true;
    const pending: string[] = this.queue.splice(0, this.queue.length);
    for (const script of pending) {
      this.execute(script);
    }
  }

  /** The page is going away; queued scripts are dropped with it. */
  reset(): void {
    this.ready = false;
    this.queue = [];
  }

  /** Runs a script now, or as soon as the page is ready. */
  run(script: string): void {
    if (!this.ready) {
      this.queue.push(script);
      return;
    }
    this.execute(script);
  }

  private execute(script: string): void {
    try {
      this.web.runJavaScript(script)
        .then(() => {})
        .catch((error: Error) => {
          AALog.debug(`Terminal script failed: ${error.message}`);
        });
    } catch (error) {
      AALog.debug(`Terminal script threw: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /**
   * Reads the page's screen as a replayable escape-sequence stream.
   *
   * The page owns the screen, so this is what lets a terminal that is shown
   * again look the way it did when the user left it — on Android that state was
   * still inside the retained emulator.
   */
  captureSnapshot(callback: (snapshot: string) => void): void {
    if (!this.ready) {
      callback('');
      return;
    }
    try {
      this.web.runJavaScript('window.__aaSnapshot()')
        .then((result: string) => {
          callback(typeof result === 'string' ? result : '');
        })
        .catch((error: Error) => {
          AALog.debug(`Terminal snapshot failed: ${error.message}`);
          callback('');
        });
    } catch (error) {
      callback('');
    }
  }

  /** Files the page's current screen under the controller that owns it. */
  captureFor(controller: RemoteTerminalController): void {
    this.captureSnapshot((snapshot: string) => {
      if (snapshot.length > 0) {
        controller.setScreenSnapshot(snapshot);
      }
    });
  }

  restore(snapshot: string): void {
    this.run(`window.__aaRestore(${JSON.stringify(snapshot)})`);
  }

  fit(): void {
    this.run('window.__aaFit()');
  }

  focus(): void {
    this.run('window.__aaFocus()');
  }

  setDarkMode(dark: boolean): void {
    this.run(`window.__aaSetTheme(${dark})`);
  }

  resetScreen(): void {
    this.run('window.__aaReset()');
  }

  write(bytes: Uint8Array): void {
    let encoded: string;
    try {
      encoded = base64Encode(bytes);
    } catch (error) {
      AALog.warn(`Dropping terminal output: ${error instanceof Error ? error.message : 'unknown'}`);
      return;
    }
    this.run(`window.__aaWrite(${JSON.stringify(encoded)}, false)`);
  }

  clearScreen(): void {
    this.run('window.__aaClear()');
  }
}

@Component
export struct TerminalContent {
  colors: AAColors = AA_LIGHT_COLORS;
  darkMode: boolean = false;
  controller: RemoteTerminalController | null = null;
  /**
   * Identifies the terminal being shown — a device id today, a session id once
   * the session terminal is reachable — and drives re-attachment.
   */
  @Prop @Watch('onTerminalKeyChanged') terminalKey: string = '';
  canReconnect: boolean = false;
  onStart: () => void = () => {};
  onReconnect: () => void = () => {};
  onClear: () => void = () => {};

  private readonly webController: webview.WebviewController = new webview.WebviewController();
  private readonly bridge: TerminalBridge = new TerminalBridge();
  private readonly sink: TerminalWebSink = new TerminalWebSink(this.webController);

  @State private status: RemoteTerminalStatus = RemoteTerminalStatus.Idle;
  @State private statusMessage: string = '';
  @State private ctrlLatched: boolean = false;
  @State private altLatched: boolean = false;
  @State private keyboardVisible: boolean = false;

  aboutToAppear(): void {
    this.bridge.dataHandler = (text: string) => this.handleData(text);
    this.bridge.resizeHandler = (cols: number, rows: number) => this.handleResize(cols, rows);
    this.bridge.modesHandler = (cursor: boolean, keypad: boolean) => this.handleModes(cursor, keypad);
    this.bridge.keyboardHandler = (visible: boolean) => {
      this.keyboardVisible = visible;
    };
    this.bridge.readyHandler = () => this.sink.markReady();
    this.attachController();
  }

  aboutToDisappear(): void {
    this.releaseController();
    this.sink.reset();
  }

  /** The chosen terminal changed; hand the surface over after the params settle. */
  onTerminalKeyChanged(): void {
    setTimeout(() => this.attachController(), 0);
  }

  private attachController(): void {
    const controller: RemoteTerminalController | null = this.controller;
    if (this.sink.targetController() === controller) {
      return;
    }
    this.releaseController();
    if (controller === null) {
      this.status = RemoteTerminalStatus.Idle;
      this.statusMessage = '';
      return;
    }

    this.sink.setTarget(controller);
    controller.attachSink(this.sink);
    controller.onStateChange = (state: RemoteTerminalState) => {
      this.status = state.status;
      this.statusMessage = state.message;
    };
    controller.onModifierChange = (modifiers: TerminalModifierState) => {
      this.ctrlLatched = modifiers.ctrl;
      this.altLatched = modifiers.alt;
    };
    this.status = controller.state().status;
    this.statusMessage = controller.state().message;
    this.ctrlLatched = controller.modifiers().ctrl;
    this.altLatched = controller.modifiers().alt;

    this.sink.setDarkMode(this.darkMode);
    const snapshot: string = controller.screenSnapshot();
    if (snapshot.length > 0) {
      controller.setScreenSnapshot('');
      this.sink.restore(snapshot);
    }
    this.sink.fit();
    this.sink.focus();
    this.onStart();
  }

  /** Snapshots and detaches the terminal currently on screen, if any. */
  private releaseController(): void {
    const previous: RemoteTerminalController | null = this.sink.targetController();
    this.sink.setTarget(null);
    if (previous === null) {
      return;
    }
    previous.onStateChange = () => {};
    previous.onModifierChange = () => {};
    this.sink.captureFor(previous);
    previous.detachSink(this.sink);
    previous.detach();
  }

  private handleData(text: string): void {
    const controller: RemoteTerminalController | null = this.controller;
    if (controller !== null) {
      controller.handlePageInput(text);
    }
  }

  private handleResize(cols: number, rows: number): void {
    const controller: RemoteTerminalController | null = this.controller;
    if (controller !== null) {
      controller.resize(cols, rows);
    }
  }

  private handleModes(cursorApplication: boolean, keypadApplication: boolean): void {
    const controller: RemoteTerminalController | null = this.controller;
    if (controller !== null) {
      controller.setModes(cursorApplication, keypadApplication);
    }
  }

  private statusText(): string {
    switch (this.status) {
      case RemoteTerminalStatus.Idle:
        return '';
      case RemoteTerminalStatus.Connecting:
        return resolveString($r('app.string.files_terminal_connecting'));
      case RemoteTerminalStatus.Open:
        return '';
      case RemoteTerminalStatus.Closed:
        return this.statusMessage.length > 0
          ? this.statusMessage : resolveString($r('app.string.files_terminal_disconnected'));
      case RemoteTerminalStatus.Exited:
        return this.statusMessage.length > 0
          ? this.statusMessage : resolveString($r('app.string.files_terminal_exited'));
      case RemoteTerminalStatus.Error:
        return this.statusMessage.length > 0
          ? this.statusMessage : resolveString($r('app.string.files_terminal_error'));
      default:
        return '';
    }
  }

  private isReconnectable(): boolean {
    return this.canReconnect && (this.status === RemoteTerminalStatus.Closed
      || this.status === RemoteTerminalStatus.Exited
      || this.status === RemoteTerminalStatus.Error);
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column() {
        this.StatusArea()

        Web({ src: $rawfile(TERMINAL_PAGE), controller: this.webController })
          .javaScriptAccess(true)
          .javaScriptProxy({
            object: this.bridge,
            name: 'aaBridge',
            methodList: BRIDGE_METHODS,
            controller: this.webController,
          })
          .domStorageAccess(false)
          .zoomAccess(false)
          .backgroundColor(this.terminalBackground())
          .layoutWeight(1)
          .width('100%')
          .onPageEnd(() => {
            this.sink.markReady();
            this.sink.setDarkMode(this.darkMode);
            this.sink.fit();
          })

        if (this.keyboardVisible) {
          this.ShortcutDeck()
        } else {
          Blank().height(24)
        }
      }
      .width('100%')
      .height('100%')
      .padding({ left: 16, right: 16 })

      this.ClearButton()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.terminalBackground())
  }

  /** `applyTerminalColors`' background: the terminal canvas itself. */
  private terminalBackground(): string {
    return this.darkMode ? '#09090B' : '#FEFDFB';
  }

  /**
   * The status strip above the terminal.
   *
   * The wrapper `Column` is always emitted, even when there is no status, so the
   * ArkWeb component below it never changes position: a changing sibling count
   * would remount the page and blank the terminal.
   */
  @Builder
  StatusArea() {
    Column() {
      if (this.statusText().length > 0) {
        if (this.status === RemoteTerminalStatus.Connecting) {
          this.ConnectingBanner(this.statusText())
        } else if (this.status === RemoteTerminalStatus.Closed
          || this.status === RemoteTerminalStatus.Exited
          || this.status === RemoteTerminalStatus.Error) {
          AuthErrorNotice({
            colors: this.colors,
            message: this.statusText(),
          })
        } else {
          Text(this.statusText())
            .fontSize(12)
            .fontWeight(600)
            .fontFamily('monospace')
            .fontColor(this.darkMode ? '#A1A1AA' : '#6F706A')
            .padding({ left: 14, right: 14 })
        }
      }
    }
    .width('100%')
    .padding(this.statusText().length > 0
      ? { top: 10, bottom: 10 }
      : { top: 0, bottom: 0 })
    .onClick(() => {
      if (this.isReconnectable()) {
        this.onReconnect();
      }
    })
  }

  /** A quiet monospace strip, not the red notice: the stream is still coming. */
  @Builder
  ConnectingBanner(message: string) {
    Row() {
      Text(message)
        .fontSize(12)
        .fontWeight(600)
        .fontFamily('monospace')
        .fontColor(this.darkMode ? '#C8D0DA' : '#47515F')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .backgroundColor(this.darkMode ? '#16181A' : '#F3F5F7')
    .border({
      width: 1,
      color: this.darkMode ? '#30343A' : '#D9DEE5',
    })
    .margin({ top: 8, bottom: 8 })
  }

  @Builder
  ClearButton() {
    Column() {
      AAIcon({
        commands: AA_ICONS.TRASH,
        iconSize: 17,
        color: this.terminalKey.length > 0
          ? (this.darkMode ? '#FCA5A5' : '#B42318')
          : (this.darkMode ? '#71717A' : '#A7A5A0'),
      })
    }
    .width(34)
    .height(34)
    .borderRadius(17)
    .backgroundColor(this.darkMode ? '#DD18181B' : '#EEFFFFFF')
    .border({
      width: 1,
      color: this.darkMode ? '#3F3F46' : '#E7E5E0',
    })
    .justifyContent(FlexAlign.Center)
    .margin({ top: 10, right: 18 })
    .accessibilityText($r('app.string.files_terminal_clear'))
    .onClick(() => {
      if (this.terminalKey.length > 0) {
        this.onClear();
      }
    })
  }

  @Builder
  ShortcutDeck() {
    Column({ space: 3 }) {
      Row() {
        this.ShortcutKey(TerminalShortcut.Esc)
        this.ShortcutKey(TerminalShortcut.Slash)
        this.ShortcutKey(TerminalShortcut.Dash)
        this.ShortcutKey(TerminalShortcut.Home)
        this.ShortcutKey(TerminalShortcut.Up)
        this.ShortcutKey(TerminalShortcut.End)
        this.ShortcutKey(TerminalShortcut.PageUp)
      }
      .width('100%')
      .layoutWeight(1)

      Row() {
        this.ShortcutKey(TerminalShortcut.Tab)
        this.ShortcutKey(TerminalShortcut.Ctrl)
        this.ShortcutKey(TerminalShortcut.Alt)
        this.ShortcutKey(TerminalShortcut.Left)
        this.ShortcutKey(TerminalShortcut.Down)
        this.ShortcutKey(TerminalShortcut.Right)
        this.ShortcutKey(TerminalShortcut.PageDown)
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height(88)
    .padding({ left: 14, right: 14, top: 6, bottom: 6 })
    .backgroundColor(this.terminalBackground())
  }

  @Builder
  ShortcutKey(shortcut: TerminalShortcut) {
    Column() {
      Text(terminalShortcutLabel(shortcut))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.isShortcutActive(shortcut)
          ? (this.darkMode ? '#67E8F9' : '#0891B2')
          : (this.darkMode ? '#FAFAFA' : '#151515'))
        .maxLines(1)
    }
    .width(0)
    .height(34)
    .layoutWeight(1)
    .borderRadius(8)
    .backgroundColor(this.isShortcutActive(shortcut)
      ? (this.darkMode ? '#1A67E8F9' : '#1A0891B2')
      : Color.Transparent)
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      const controller: RemoteTerminalController | null = this.controller;
      if (controller !== null) {
        controller.sendShortcut(shortcut);
      }
    })
  }

  private isShortcutActive(shortcut: TerminalShortcut): boolean {
    return (shortcut === TerminalShortcut.Ctrl && this.ctrlLatched)
      || (shortcut === TerminalShortcut.Alt && this.altLatched);
  }
}
