import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { AgentDevice, AgentSession } from '../../model/AgentSession';
import { AALog } from '../../common/AAAppLog';
import { base64Decode, base64Encode } from '../../common/AAEncoding';
import { TerminalController, WorkspaceTerminalConnection } from './TerminalController';
import { DrainBatch, RemoteTerminalOutputBuffer, ScheduleDecision } from './RemoteTerminalOutputBuffer';
import {
  keyHandlerCode, keyModifierNumber, shortcutKeyCode, TerminalShortcut,
} from './TerminalKeys';

/**
 * Remote terminal session.
 *
 * Port of `feature/terminal/RemoteTerminalController.kt`.
 *
 * Android hands the byte stream to a Termux `TerminalEmulator` and paints the
 * screen with a `RemoteTerminalView`. This port keeps the same controller shape
 * — the same WebSocket protocol, the same reconnect and drain policy, the same
 * input latching — but the terminal itself is xterm.js inside an ArkWeb page, so
 * the "screen" the controller writes to is a `TerminalScreenSink` instead of a
 * `TerminalEmulator`.
 *
 * What that changes, and only that:
 *  - there is no local escape-sequence parser, so `emitRedraw` disappears;
 *    xterm repaints itself when it is written to;
 *  - the application-cursor and application-keypad modes live inside xterm, so
 *    the page reports them (`setModes`) and the deck reads them here;
 *  - the screen contents live inside the page, so a snapshot is captured when
 *    the page goes away and restored when the same controller is shown again —
 *    on Android that state lived in the retained emulator.
 *
 * Everything the Server sees is unchanged: `input` and `resize` frames out,
 * `replay`/`output`/`exit`/`error` frames in, `fromSeq` resume after a drop.
 */

/** Messages the page can be asked for. */
export interface TerminalScreenSink {
  /** Forgets the screen, because a `replay` frame is about to replace it. */
  resetScreen(): void;
  /** Appends raw terminal bytes. */
  write(bytes: Uint8Array): void;
  /** Clears the screen and the scrollback, without touching terminal modes. */
  clearScreen(): void;
  /** Switches the palette; the page owns the actual colours. */
  setDarkMode(dark: boolean): void;
}

export enum RemoteTerminalStatus {
  Idle = 0,
  Connecting = 1,
  Open = 2,
  Closed = 3,
  Exited = 4,
  Error = 5,
}

export class RemoteTerminalState {
  status: RemoteTerminalStatus = RemoteTerminalStatus.Idle;
  message: string = '';

  constructor(status: RemoteTerminalStatus = RemoteTerminalStatus.Idle, message: string = '') {
    this.status = status;
    this.message = message;
  }
}

export class TerminalModifierState {
  ctrl: boolean = false;
  alt: boolean = false;

  constructor(ctrl: boolean = false, alt: boolean = false) {
    this.ctrl = ctrl;
    this.alt = alt;
  }
}

const RECONNECT_DELAY_MS: number = 800;
const STREAM_OPEN_GRACE_MS: number = 1200;
const MAX_RECONNECT_ATTEMPTS: number = 3;
const REMOTE_RESIZE_DEBOUNCE_MS: number = 160;
const OUTPUT_DRAIN_DELAY_MS: number = 16;

/** `ESC [ H`, `ESC [ 2 J`, `ESC [ 3 J`: home, erase screen, erase scrollback. */
const CLEAR_SCREEN_SEQUENCE: string = '\u001b[H\u001b[2J\u001b[3J';

/** One queued outbound frame, kept with the socket it belongs to. */
class OutboundFrame {
  socket: webSocket.WebSocket;
  frame: string;
  kind: string;

  constructor(socket: webSocket.WebSocket, frame: string, kind: string) {
    this.socket = socket;
    this.frame = frame;
    this.kind = kind;
  }
}

class InputFrame {
  type: string = 'input';
  data: string = '';

  constructor(data: string) {
    this.data = data;
  }
}

class ResizeFrame {
  type: string = 'resize';
  cols: number = 0;
  rows: number = 0;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
}

class TerminalCloseTarget {
  connectorId: string = '';
  terminalId: string = '';

  constructor(connectorId: string, terminalId: string) {
    this.connectorId = connectorId;
    this.terminalId = terminalId;
  }
}

export class RemoteTerminalController {
  private readonly terminalController: TerminalController;
  private readonly outputBuffer: RemoteTerminalOutputBuffer = new RemoteTerminalOutputBuffer();
  private sink: TerminalScreenSink | null = null;

  private stateValue: RemoteTerminalState = new RemoteTerminalState();
  private modifierValue: TerminalModifierState = new TerminalModifierState();

  /** Notified whenever the connection status changes. */
  onStateChange: (state: RemoteTerminalState) => void = () => {};
  /** Notified whenever the control/alt latches change. */
  onModifierChange: (state: TerminalModifierState) => void = () => {};

  private socket: webSocket.WebSocket | null = null;
  private readonly groupId: string = `mobile_${randomGroupSuffix()}`;
  private connectorId: string | null = null;
  private terminalId: string | null = null;
  private streamUrl: string | null = null;
  private streamAuthorizationToken: string | null = null;
  private reconnectScheduled: boolean = false;
  private reconnectAttempts: number = 0;
  private lastSeenSeq: number = 0;
  private lastCols: number = 80;
  private lastRows: number = 24;
  private remoteDeviceOs: string | null = null;
  private manuallyClosed: boolean = false;
  private remoteTerminalGone: boolean = false;
  private ctrlLatched: boolean = false;
  private altLatched: boolean = false;
  private cursorApplicationMode: boolean = false;
  private keypadApplicationMode: boolean = false;
  private pendingRemoteResizeCols: number = -1;
  private pendingRemoteResizeRows: number = -1;
  private remoteResizeGeneration: number = 0;
  private lastSentRemoteResizeCols: number = -1;
  private lastSentRemoteResizeRows: number = -1;
  private inputSeq: number = 0;
  private frameSeq: number = 0;
  private readonly pendingInput: Uint8Array[] = [];
  private readonly sendQueue: OutboundFrame[] = [];
  private sendInFlight: boolean = false;
  private drainTimer: number = -1;
  private disposed: boolean = false;
  /** The page's screen contents, kept so a re-shown terminal is not blank. */
  private snapshot: string = '';

  constructor(terminalController: TerminalController) {
    this.terminalController = terminalController;
  }

  // ------------------------------------------------------------- attachment

  attachSink(sink: TerminalScreenSink): void {
    this.sink = sink;
  }

  detachSink(sink: TerminalScreenSink): void {
    if (this.sink === sink) {
      this.sink = null;
    }
  }

  /** The captured screen, or an empty string when there is nothing to restore. */
  screenSnapshot(): string {
    return this.snapshot;
  }

  setScreenSnapshot(snapshot: string): void {
    this.snapshot = snapshot;
  }

  state(): RemoteTerminalState {
    return this.stateValue;
  }

  modifiers(): TerminalModifierState {
    return this.modifierValue;
  }

  private setState(next: RemoteTerminalState): void {
    this.stateValue = next;
    this.onStateChange(next);
  }

  // ------------------------------------------------------------- lifecycle

  /** Opens (or resumes) the terminal rooted at a session's workspace. */
  async ensureStarted(session: AgentSession): Promise<void> {
    this.remoteDeviceOs = null;
    if (this.terminalId !== null && this.connectorId === session.connectorId) {
      this.reconnectExistingIfNeeded(false);
      return;
    }
    const hadTerminal: boolean = this.terminalId !== null;
    this.detach();
    if (hadTerminal) {
      this.clearLocalScreen();
    }
    if (session.cwd === null || session.cwd.length === 0) {
      this.setState(new RemoteTerminalState(
        RemoteTerminalStatus.Error, 'This session has no workspace.',
      ));
      return;
    }
    this.setState(new RemoteTerminalState(RemoteTerminalStatus.Connecting));
    let connection: WorkspaceTerminalConnection;
    try {
      connection = await this.terminalController.openWorkspaceTerminal(
        session, this.lastCols, this.lastRows, this.groupId,
      );
    } catch (error) {
      this.setState(new RemoteTerminalState(
        RemoteTerminalStatus.Error,
        error instanceof Error ? error.message : 'Could not open terminal.',
      ));
      return;
    }
    this.adoptConnection(connection);
  }

  /** Opens (or resumes) a terminal on a device, in its home directory. */
  async ensureStartedDevice(device: AgentDevice): Promise<void> {
    this.remoteDeviceOs = device.deviceOs;
    if (this.terminalId !== null && this.connectorId === device.id) {
      this.reconnectExistingIfNeeded(false);
      return;
    }
    const hadTerminal: boolean = this.terminalId !== null;
    this.detach();
    if (hadTerminal) {
      this.clearLocalScreen();
    }
    if (!device.online) {
      this.setState(new RemoteTerminalState(
        RemoteTerminalStatus.Error, 'This device is offline.',
      ));
      return;
    }
    this.setState(new RemoteTerminalState(RemoteTerminalStatus.Connecting));
    let connection: WorkspaceTerminalConnection;
    try {
      connection = await this.terminalController.openDeviceTerminal(
        device.id, this.lastCols, this.lastRows, this.groupId,
      );
    } catch (error) {
      this.setState(new RemoteTerminalState(
        RemoteTerminalStatus.Error,
        error instanceof Error ? error.message : 'Could not open terminal.',
      ));
      return;
    }
    this.adoptConnection(connection);
  }

  /** Reconnects, restarting an exited terminal. */
  async reconnectDevice(device: AgentDevice): Promise<void> {
    if (this.terminalId !== null && this.connectorId === device.id
      && this.stateValue.status !== RemoteTerminalStatus.Exited) {
      this.reconnectExistingIfNeeded(true);
    } else if (this.terminalId !== null && this.connectorId === device.id) {
      await this.restartDevice(device);
    } else {
      await this.ensureStartedDevice(device);
    }
  }

  /** Reconnects, restarting an exited terminal. */
  async reconnectSession(session: AgentSession): Promise<void> {
    if (this.terminalId !== null && this.connectorId === session.connectorId
      && this.stateValue.status !== RemoteTerminalStatus.Exited) {
      this.reconnectExistingIfNeeded(true);
    } else if (this.terminalId !== null && this.connectorId === session.connectorId) {
      await this.restartSession(session);
    } else {
      await this.ensureStarted(session);
    }
  }

  /** Closes the remote terminal and starts a fresh one. */
  async restartDevice(device: AgentDevice): Promise<void> {
    await this.close();
    await this.ensureStartedDevice(device);
  }

  /** Closes the remote terminal and starts a fresh one. */
  async restartSession(session: AgentSession): Promise<void> {
    await this.close();
    await this.ensureStarted(session);
  }

  /** Closes the remote terminal for real: the Server kills the shell. */
  async close(): Promise<void> {
    const target: TerminalCloseTarget | null = this.detachTerminalForClose();
    this.clearLocalScreen();
    if (target !== null) {
      try {
        await this.terminalController.closeTerminal(target.connectorId, target.terminalId);
      } catch (error) {
        AALog.warn(`Closing the terminal failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  /** Drops the connection but leaves the remote shell running. */
  detach(): void {
    this.manuallyClosed = true;
    this.closeSocket(this.socket, 1000, 'detached');
    this.socket = null;
    this.reconnectScheduled = false;
    this.reconnectAttempts = 0;
    this.remoteTerminalGone = false;
    this.cancelPendingRemoteResize();
    this.setLatched(false, false);
    this.pendingInput.length = 0;
    if (this.terminalId !== null && this.stateValue.status !== RemoteTerminalStatus.Exited) {
      this.setState(new RemoteTerminalState(RemoteTerminalStatus.Closed));
    }
  }

  /** Permanently retires this controller. */
  disposeLocal(): void {
    this.disposed = true;
    this.detach();
    this.cancelDrainTimer();
  }

  // ------------------------------------------------------------- geometry

  /**
   * Applies a new terminal size.
   *
   * The local renderer measures its own cells, so only the grid size matters:
   * the page has already resized xterm by the time this is called, and the
   * Server is told 160 ms later if the size settles.
   */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return;
    }
    if (cols === this.lastCols && rows === this.lastRows) {
      return;
    }
    this.lastCols = cols;
    this.lastRows = rows;
    this.scheduleRemoteResize(cols, rows);
  }

  // ------------------------------------------------------------- input

  /**
   * Everything the page produces for the shell.
   *
   * Android splits this in two: the view sends keystrokes straight to
   * `sendBytes`, while the emulator's own responses pass through a filter that
   * drops a private device-attributes reply on Windows ptys. xterm delivers both
   * kinds through one `onData` event, so the filter is applied here instead —
   * the sequence it looks for cannot be produced by typing.
   */
  handlePageInput(text: string): void {
    if (text.length === 0) {
      return;
    }
    if (shouldSuppressTerminalResponse(this.remoteDeviceOs, utf8Bytes(text))) {
      return;
    }
    this.sendText(text);
  }

  /** Input from the page; the control and alt latches apply to its first byte. */
  sendText(text: string): void {
    if (text.length === 0) {
      return;
    }
    let data: string;
    if (this.ctrlLatched) {
      data = text.length > 0
        ? codePointString(controlCodePoint(text.charCodeAt(0)))
        : text;
    } else if (this.altLatched) {
      data = `\u001b${text}`;
    } else {
      data = text;
    }
    this.setLatched(false, false);
    this.sendBytes(utf8Bytes(data));
  }

  /** Input that bypasses the latches, used by the deck's raw keys. */
  sendRawText(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.setLatched(false, false);
    this.sendBytes(utf8Bytes(text));
  }

  /** The keypad modes xterm is currently in, reported by the page. */
  setModes(cursorApplication: boolean, keypadApplication: boolean): void {
    this.cursorApplicationMode = cursorApplication;
    this.keypadApplicationMode = keypadApplication;
  }

  sendCodePoint(codePoint: number, controlDown: boolean, altDown: boolean): void {
    if (codePoint < 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
      return;
    }
    const control: boolean = controlDown || this.ctrlLatched;
    const alt: boolean = altDown || this.altLatched;
    const mappedCodePoint: number = control ? controlCodePoint(codePoint) : codePoint;
    this.setLatched(false, false);
    const text: string = codePointString(mappedCodePoint);
    this.sendBytes(utf8Bytes(alt ? `\u001b${text}` : text));
  }

  /** One key of the shortcut deck. */
  sendShortcut(shortcut: TerminalShortcut): void {
    if (shortcut === TerminalShortcut.Ctrl) {
      this.setLatched(!this.ctrlLatched, this.altLatched);
      return;
    }
    if (shortcut === TerminalShortcut.Alt) {
      this.setLatched(this.ctrlLatched, !this.altLatched);
      return;
    }
    if (shortcut === TerminalShortcut.Slash) {
      this.sendCodePoint('/'.charCodeAt(0), false, false);
      return;
    }
    if (shortcut === TerminalShortcut.Dash) {
      this.sendCodePoint('-'.charCodeAt(0), false, false);
      return;
    }
    if (shortcut === TerminalShortcut.Tab) {
      this.sendRawText('\t');
      return;
    }
    if (shortcut === TerminalShortcut.Esc) {
      this.sendRawText('\u001b');
      return;
    }
    this.sendKeyShortcut(shortcut);
  }

  private sendKeyShortcut(shortcut: TerminalShortcut): void {
    const keyCode: number = shortcutKeyCode(shortcut);
    if (keyCode < 0) {
      return;
    }
    const modifier: number = keyModifierNumber(this.ctrlLatched, this.altLatched);
    this.setLatched(false, false);
    const sequence: string | null = keyHandlerCode(keyCode, modifier, this.cursorApplicationMode);
    if (sequence !== null) {
      this.sendBytes(utf8Bytes(sequence));
    }
  }

  private setLatched(ctrl: boolean, alt: boolean): void {
    this.ctrlLatched = ctrl;
    this.altLatched = alt;
    this.modifierValue = new TerminalModifierState(ctrl, alt);
    this.onModifierChange(this.modifierValue);
  }

  private sendBytes(bytes: Uint8Array): void {
    this.inputSeq += 1;
    if (this.stateValue.status !== RemoteTerminalStatus.Open) {
      if (this.terminalId !== null && this.streamUrl !== null && !this.manuallyClosed) {
        this.pendingInput.push(bytes);
        this.scheduleReconnect();
      }
      return;
    }
    this.sendFrame('input', JSON.stringify(new InputFrame(base64Encode(bytes))));
  }

  private sendFrame(kind: string, frame: string): void {
    const target: webSocket.WebSocket | null = this.socket;
    if (target === null) {
      return;
    }
    this.frameSeq += 1;
    this.sendQueue.push(new OutboundFrame(target, frame, kind));
    this.drainSendQueue();
  }

  /** Serializes frames, because `send` is asynchronous and order matters. */
  private drainSendQueue(): void {
    if (this.sendInFlight) {
      return;
    }
    const next: OutboundFrame | undefined = this.sendQueue.shift();
    if (next === undefined) {
      return;
    }
    if (this.socket !== next.socket || this.manuallyClosed) {
      this.drainSendQueue();
      return;
    }
    this.sendInFlight = true;
    next.socket.send(next.frame)
      .then((accepted: boolean) => {
        this.sendInFlight = false;
        if (!accepted && !this.manuallyClosed) {
          this.setState(new RemoteTerminalState(RemoteTerminalStatus.Closed));
        }
        this.drainSendQueue();
      })
      .catch((error: Error) => {
        this.sendInFlight = false;
        AALog.debug(`Frame send failed: ${error.message}`);
        if (!this.manuallyClosed) {
          this.setState(new RemoteTerminalState(RemoteTerminalStatus.Closed));
        }
        this.drainSendQueue();
      });
  }

  private flushPendingInput(): void {
    if (this.pendingInput.length === 0) {
      return;
    }
    const queued: Uint8Array[] = this.pendingInput.splice(0, this.pendingInput.length);
    for (const bytes of queued) {
      this.sendFrame('input', JSON.stringify(new InputFrame(base64Encode(bytes))));
    }
  }

  // ------------------------------------------------------------- socket

  private adoptConnection(connection: WorkspaceTerminalConnection): void {
    this.connectorId = connection.connectorId;
    this.terminalId = connection.terminal.terminalId;
    this.streamUrl = connection.streamUrl;
    this.streamAuthorizationToken = connection.authorizationToken;
    this.lastSeenSeq = 0;
    this.reconnectAttempts = 0;
    this.remoteTerminalGone = false;
    this.connectSocket(connection.streamUrl);
  }

  private connectSocket(url: string): void {
    this.manuallyClosed = false;
    let socket: webSocket.WebSocket;
    try {
      socket = webSocket.createWebSocket();
    } catch (error) {
      this.setState(new RemoteTerminalState(
        RemoteTerminalStatus.Error,
        error instanceof Error ? error.message : 'Could not open terminal.',
      ));
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      if (this.socket !== socket || this.manuallyClosed) {
        this.closeSocket(socket, 1000, 'stale');
        return;
      }
      this.sendRemoteResizeNow(this.lastCols, this.lastRows, true);
      this.flushPendingInput();
      this.confirmOpenIfNoStreamFrame(socket);
    });

    socket.on('message', (error, value: string | ArrayBuffer) => {
      if (this.socket !== socket || this.manuallyClosed) {
        return;
      }
      if (typeof value === 'string') {
        this.handleFrame(value);
        return;
      }
      // Android's listener only implements the text overload, so a binary frame
      // is decoded and offered to the same parser: a real frame is still handled,
      // and anything else is ignored exactly as before.
      const text: string = decodeUtf8(value);
      if (text.length > 0) {
        this.handleFrame(text);
      }
    });

    socket.on('close', (error, value: webSocket.CloseResult) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      const code: number = value === undefined || value === null ? 0 : value.code;
      if (isUnauthorizedTerminalConnection(0, code)) {
        this.manuallyClosed = true;
        const token: string | null = this.streamAuthorizationToken;
        if (token !== null) {
          this.terminalController.notifyUnauthorized(token);
        }
        return;
      }
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (error: BusinessError) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      AALog.debug(`Terminal stream failed: ${error.code}`);
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    socket.connect(url)
      .then((accepted: boolean) => {
        if (!accepted && this.socket === socket && !this.manuallyClosed) {
          this.socket = null;
          this.scheduleReconnect();
        }
      })
      .catch((error: Error) => {
        if (this.socket !== socket) {
          return;
        }
        this.socket = null;
        AALog.debug(`Terminal stream connect failed: ${error.message}`);
        if (!this.manuallyClosed) {
          this.scheduleReconnect();
        }
      });
  }

  private closeSocket(socket: webSocket.WebSocket | null, code: number, reason: string): void {
    if (socket === null) {
      return;
    }
    try {
      const options: webSocket.WebSocketCloseOptions = { code: code, reason: reason };
      socket.close(options);
    } catch (error) {
      AALog.debug(`Closing the terminal socket failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private handleFrame(text: string): void {
    let root: Record<string, Object>;
    try {
      root = JSON.parse(text) as Record<string, Object>;
    } catch (error) {
      return;
    }
    const type: Object = root.type;
    if (typeof type !== 'string') {
      return;
    }

    if (type === 'replay' || type === 'output') {
      const seqValue: Object = root.seq;
      const seq: number = typeof seqValue === 'number' ? seqValue : -1;
      if (seq > 0 && seq <= this.lastSeenSeq) {
        return;
      }
      if (seq > 0) {
        this.lastSeenSeq = seq;
      }
      const dataValue: Object = root.data;
      if (typeof dataValue !== 'string') {
        return;
      }
      let data: Uint8Array;
      try {
        data = base64Decode(dataValue);
      } catch (error) {
        return;
      }
      this.reconnectAttempts = 0;
      this.remoteTerminalGone = false;
      this.setState(new RemoteTerminalState(RemoteTerminalStatus.Open));
      this.enqueueTerminalOutput(data, type === 'replay');
      return;
    }

    if (type === 'exit') {
      this.manuallyClosed = true;
      const socket: webSocket.WebSocket | null = this.socket;
      this.closeSocket(socket, 1000, 'terminal exited');
      this.socket = null;
      this.setState(new RemoteTerminalState(RemoteTerminalStatus.Exited));
      return;
    }

    if (type === 'error') {
      const messageValue: Object = root.message;
      const message: string = typeof messageValue === 'string' ? messageValue : '';
      if (message.toLowerCase().includes('terminal not found')) {
        this.remoteTerminalGone = true;
      }
      this.setState(new RemoteTerminalState(RemoteTerminalStatus.Closed));
    }
  }

  /**
   * Some Servers answer a healthy socket with nothing at all, so a socket that
   * opened and stayed quiet is treated as connected after a short grace period.
   */
  private confirmOpenIfNoStreamFrame(socket: webSocket.WebSocket): void {
    setTimeout(() => {
      if (this.socket === socket
        && !this.manuallyClosed
        && this.stateValue.status === RemoteTerminalStatus.Connecting
        && !this.remoteTerminalGone) {
        this.reconnectAttempts = 0;
        this.setState(new RemoteTerminalState(RemoteTerminalStatus.Open));
      }
    }, STREAM_OPEN_GRACE_MS);
  }

  private scheduleReconnect(): void {
    const originalUrl: string | null = this.streamUrl;
    if (originalUrl === null || this.manuallyClosed || this.terminalId === null) {
      return;
    }
    if (this.reconnectScheduled) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.remoteTerminalGone) {
        this.forgetRemoteTerminal();
      }
      this.setState(new RemoteTerminalState(RemoteTerminalStatus.Closed));
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectScheduled = true;
    this.setState(new RemoteTerminalState(RemoteTerminalStatus.Closed));
    setTimeout(() => {
      this.reconnectScheduled = false;
      if (this.manuallyClosed || this.socket !== null || this.terminalId === null
        || this.streamUrl !== originalUrl) {
        return;
      }
      this.connectSocket(withFromSeq(originalUrl, this.lastSeenSeq));
    }, RECONNECT_DELAY_MS);
  }

  private forgetRemoteTerminal(): void {
    this.closeSocket(this.socket, 1000, 'forgotten');
    this.socket = null;
    this.connectorId = null;
    this.terminalId = null;
    this.streamUrl = null;
    this.streamAuthorizationToken = null;
    this.reconnectScheduled = false;
    this.remoteTerminalGone = false;
    this.cancelPendingRemoteResize();
    this.outputBuffer.clear();
    this.pendingInput.length = 0;
  }

  private reconnectExistingIfNeeded(force: boolean): void {
    const url: string | null = this.streamUrl;
    if (url === null) {
      return;
    }
    if (!force && (this.socket !== null || this.stateValue.status === RemoteTerminalStatus.Connecting)) {
      return;
    }
    this.closeSocket(this.socket, 1000, 'reconnect');
    this.socket = null;
    this.manuallyClosed = false;
    this.reconnectScheduled = false;
    this.reconnectAttempts = 0;
    this.remoteTerminalGone = false;
    this.setState(new RemoteTerminalState(RemoteTerminalStatus.Connecting));
    this.connectSocket(withFromSeq(url, this.lastSeenSeq));
  }

  private detachTerminalForClose(): TerminalCloseTarget | null {
    this.manuallyClosed = true;
    this.closeSocket(this.socket, 1000, 'closed');
    this.socket = null;
    const currentConnectorId: string | null = this.connectorId;
    const currentTerminalId: string | null = this.terminalId;
    this.connectorId = null;
    this.terminalId = null;
    this.streamUrl = null;
    this.streamAuthorizationToken = null;
    this.reconnectScheduled = false;
    this.reconnectAttempts = 0;
    this.remoteTerminalGone = false;
    this.cancelPendingRemoteResize();
    this.setLatched(false, false);
    this.pendingInput.length = 0;
    this.setState(new RemoteTerminalState());
    if (currentConnectorId !== null && currentTerminalId !== null) {
      return new TerminalCloseTarget(currentConnectorId, currentTerminalId);
    }
    return null;
  }

  // ------------------------------------------------------------- resizing

  private scheduleRemoteResize(cols: number, rows: number): void {
    this.pendingRemoteResizeCols = cols;
    this.pendingRemoteResizeRows = rows;
    this.remoteResizeGeneration += 1;
    const generation: number = this.remoteResizeGeneration;
    setTimeout(() => {
      if (generation !== this.remoteResizeGeneration || this.manuallyClosed) {
        return;
      }
      const pendingCols: number = this.pendingRemoteResizeCols;
      const pendingRows: number = this.pendingRemoteResizeRows;
      if (pendingCols <= 0 || pendingRows <= 0) {
        return;
      }
      this.pendingRemoteResizeCols = -1;
      this.pendingRemoteResizeRows = -1;
      this.sendRemoteResizeNow(pendingCols, pendingRows, false);
    }, REMOTE_RESIZE_DEBOUNCE_MS);
  }

  private cancelPendingRemoteResize(): void {
    this.remoteResizeGeneration += 1;
    this.pendingRemoteResizeCols = -1;
    this.pendingRemoteResizeRows = -1;
  }

  private sendRemoteResizeNow(cols: number, rows: number, force: boolean): void {
    if (cols <= 0 || rows <= 0 || this.socket === null) {
      return;
    }
    if (!force && cols === this.lastSentRemoteResizeCols && rows === this.lastSentRemoteResizeRows) {
      return;
    }
    this.lastSentRemoteResizeCols = cols;
    this.lastSentRemoteResizeRows = rows;
    this.sendFrame('resize', JSON.stringify(new ResizeFrame(cols, rows)));
  }

  // ------------------------------------------------------------- rendering

  /**
   * Local clear: drop everything queued, then erase the screen and the
   * scrollback. Terminal modes are deliberately left alone, which is why this
   * writes an escape sequence instead of resetting the parser.
   */
  private clearLocalScreen(): void {
    this.outputBuffer.clear();
    this.cancelDrainTimer();
    const sink: TerminalScreenSink | null = this.sink;
    if (sink !== null) {
      sink.clearScreen();
    }
  }

  private enqueueTerminalOutput(data: Uint8Array, resetBeforeAppend: boolean): void {
    const decision: ScheduleDecision = this.outputBuffer.enqueue(data, resetBeforeAppend);
    if (decision.shouldSchedule) {
      this.scheduleOutputDrain(decision.generation);
    }
  }

  private scheduleOutputDrain(generation: number): void {
    this.cancelDrainTimer();
    this.drainTimer = setTimeout(() => {
      this.drainTimer = -1;
      this.drainTerminalOutput(generation);
    }, OUTPUT_DRAIN_DELAY_MS);
  }

  private cancelDrainTimer(): void {
    if (this.drainTimer >= 0) {
      clearTimeout(this.drainTimer);
      this.drainTimer = -1;
    }
  }

  private drainTerminalOutput(generation: number): void {
    const batch: DrainBatch | null = this.outputBuffer.drain(generation);
    if (batch === null) {
      this.outputBuffer.finishDrain(generation);
      return;
    }
    const sink: TerminalScreenSink | null = this.sink;
    if (sink !== null) {
      if (batch.resetBeforeAppend) {
        sink.resetScreen();
      }
      if (batch.hasData()) {
        sink.write(batch.data);
      }
    }
    const next: ScheduleDecision = this.outputBuffer.finishDrain(generation);
    if (next.shouldSchedule) {
      this.scheduleOutputDrain(next.generation);
    }
  }

  /** The page changed its palette. */
  setDarkMode(dark: boolean): void {
    const sink: TerminalScreenSink | null = this.sink;
    if (sink !== null) {
      sink.setDarkMode(dark);
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * A stream rejected because the bearer token is gone.
 *
 * Android checks both the HTTP status of a failed upgrade (`401`) and the close
 * code the Server uses after a successful upgrade (`4401`). The platform
 * WebSocket API does not expose the status code of a refused handshake, so only
 * the close code can be observed here.
 */
export function isUnauthorizedTerminalConnection(
  httpStatusCode: number = 0,
  closeCode: number = 0,
): boolean {
  return httpStatusCode === 401 || closeCode === 4401;
}

/** `ESC [ ? … c`, the private device-attributes reply a Windows pty mishandles. */
export function isPrivateDeviceAttributesResponse(bytes: Uint8Array): boolean {
  const count: number = bytes.length;
  if (count < 4) {
    return false;
  }
  let index: number = 0;
  const first: number = bytes[0];
  if (first === 0x1B) {
    if (index + 2 >= count || bytes[index + 1] !== 0x5B) {
      return false;
    }
    index += 2;
  } else if (first === 0x9B) {
    index += 1;
  } else {
    return false;
  }
  if (index >= count || bytes[index] !== 0x3F) {
    return false;
  }
  index += 1;
  if (index >= count) {
    return false;
  }
  while (index < count - 1) {
    const value: number = bytes[index];
    if ((value < 0x30 || value > 0x39) && value !== 0x3B) {
      return false;
    }
    index += 1;
  }
  return index === count - 1 && bytes[index] === 0x63;
}

/** Whether a terminal response must be swallowed for this device. */
export function shouldSuppressTerminalResponse(deviceOs: string | null, bytes: Uint8Array): boolean {
  if (deviceOs === null || deviceOs.toLowerCase() !== 'windows') {
    return false;
  }
  return isPrivateDeviceAttributesResponse(bytes);
}

/** Rewrites (or appends) the `fromSeq` query parameter. */
export function withFromSeq(url: string, seq: number): string {
  if (url.includes('fromSeq=')) {
    return url.replace(/fromSeq=\d+/, `fromSeq=${seq}`);
  }
  return `${url}${url.includes('?') ? '&' : '?'}fromSeq=${seq}`;
}

/** Kotlin's `Character.toChars(codePoint)` as a string. */
function codePointString(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

/** Android's `controlCodePoint`: the caret-notation mapping for control keys. */
function controlCodePoint(codePoint: number): number {
  if (codePoint >= 0x61 && codePoint <= 0x7A) {
    return codePoint - 0x61 + 1;
  }
  if (codePoint >= 0x41 && codePoint <= 0x5A) {
    return codePoint - 0x41 + 1;
  }
  switch (codePoint) {
    case 0x20:
    case 0x32:
      return 0;
    case 0x5B:
    case 0x33:
      return 27;
    case 0x5C:
    case 0x34:
      return 28;
    case 0x5D:
    case 0x35:
      return 29;
    case 0x5E:
    case 0x36:
      return 30;
    case 0x5F:
    case 0x37:
    case 0x2F:
      return 31;
    default:
      return codePoint;
  }
}

/** UTF-8 bytes for a JavaScript string, without a BOM. */
export function utf8Bytes(text: string): Uint8Array {
  try {
    const encoder: util.TextEncoder = new util.TextEncoder();
    return encoder.encodeInto(text);
  } catch (error) {
    throw new Error(`Encoding terminal input failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

/** Decodes a WebSocket binary frame; an undecodable frame reads as empty. */
function decodeUtf8(buffer: ArrayBuffer): string {
  try {
    const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(new Uint8Array(buffer));
  } catch (error) {
    return '';
  }
}

/** The random half of the ephemeral group id, mirroring `UUID.randomUUID()`. */
function randomGroupSuffix(): string {
  try {
    return util.generateRandomUUID(true);
  } catch (error) {
    return `${Date.now()}`;
  }
}
