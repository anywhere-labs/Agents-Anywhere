import { RemoteTerminal } from '../../api/TerminalDtos';
import { TerminalApi } from '../../api/TerminalApi';
import { AgentSession } from '../../model/AgentSession';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { AALog } from '../../common/AAAppLog';

/**
 * Terminal workflows.
 *
 * Port of `feature/terminal/TerminalController.kt`.
 *
 * Opening a terminal is deliberately idempotent: before creating one, the
 * controller lists the connector's terminals and reuses the newest one whose
 * label matches this app instance's label for that session or device. That is
 * why `uniqueTerminalLabel` has to reproduce Java's `String.hashCode` exactly —
 * the label is the only handle the reuse rule has, and a different hash would
 * leak a new terminal on every launch.
 */

const TERMINAL_LABEL_MAX_CHARS: number = 64;

export class WorkspaceTerminalConnection {
  connectorId: string = '';
  terminal: RemoteTerminal = new RemoteTerminal();
  streamUrl: string = '';
  authorizationToken: string = '';

  constructor(
    connectorId: string,
    terminal: RemoteTerminal,
    streamUrl: string,
    authorizationToken: string,
  ) {
    this.connectorId = connectorId;
    this.terminal = terminal;
    this.streamUrl = streamUrl;
    this.authorizationToken = authorizationToken;
  }
}

class ApiAuth {
  serverUrl: string = '';
  accessToken: string = '';

  constructor(serverUrl: string, accessToken: string) {
    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
  }
}

export class TerminalController {
  private readonly terminalApi: TerminalApi;
  private readonly sessionStore: AuthSessionStore;

  constructor(terminalApi: TerminalApi, sessionStore: AuthSessionStore) {
    this.terminalApi = terminalApi;
    this.sessionStore = sessionStore;
  }

  /** Opens (or reuses) the terminal rooted at a session's workspace. */
  async openWorkspaceTerminal(
    session: AgentSession,
    cols: number,
    rows: number,
    ephemeralGroupId: string,
  ): Promise<WorkspaceTerminalConnection> {
    const root: string = session.cwd === null || session.cwd.length === 0 ? '' : session.cwd;
    if (root.length === 0) {
      throw new Error('This session has no workspace.');
    }
    const auth: ApiAuth = this.authSession();
    const label: string = uniqueTerminalLabel('AA Session', session.id);
    const reused: RemoteTerminal | null = await this.findReusableTerminal(
      auth, session.connectorId, label,
    );
    const terminal: RemoteTerminal = reused !== null ? reused : await this.terminalApi.createTerminal(
      auth.serverUrl, auth.accessToken, session.connectorId, root,
      cols, rows, ephemeralGroupId, label,
    );
    return new WorkspaceTerminalConnection(
      session.connectorId,
      terminal,
      this.terminalApi.streamUrl(
        auth.serverUrl, auth.accessToken, session.connectorId, terminal.terminalId,
      ),
      auth.accessToken,
    );
  }

  /** Opens (or reuses) a terminal in the device's home directory. */
  async openDeviceTerminal(
    connectorId: string,
    cols: number,
    rows: number,
    ephemeralGroupId: string,
  ): Promise<WorkspaceTerminalConnection> {
    const auth: ApiAuth = this.authSession();
    const label: string = uniqueTerminalLabel('AA Device', connectorId);
    const reused: RemoteTerminal | null = await this.findReusableTerminal(auth, connectorId, label);
    const terminal: RemoteTerminal = reused !== null ? reused : await this.terminalApi.createTerminal(
      auth.serverUrl, auth.accessToken, connectorId, '~', cols, rows, ephemeralGroupId, label,
    );
    return new WorkspaceTerminalConnection(
      connectorId,
      terminal,
      this.terminalApi.streamUrl(auth.serverUrl, auth.accessToken, connectorId, terminal.terminalId),
      auth.accessToken,
    );
  }

  /** Closes a terminal; a failure here is reported by the caller, not retried. */
  async closeTerminal(connectorId: string, terminalId: string): Promise<void> {
    const auth: ApiAuth = this.authSession();
    await this.terminalApi.closeTerminal(
      auth.serverUrl, auth.accessToken, connectorId, terminalId,
    );
  }

  /**
   * The newest non-exited terminal carrying this label.
   *
   * Android wraps the list call in `runCatching` and treats any failure — an
   * offline device, a Server that does not know the route — as "nothing to
   * reuse", so that the create call that follows produces the real error.
   */
  private async findReusableTerminal(
    auth: ApiAuth,
    connectorId: string,
    label: string,
  ): Promise<RemoteTerminal | null> {
    let terminals: RemoteTerminal[] = [];
    try {
      terminals = await this.terminalApi.listTerminals(
        auth.serverUrl, auth.accessToken, connectorId,
      );
    } catch (error) {
      AALog.debug(`Terminal reuse lookup failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
    let best: RemoteTerminal | null = null;
    for (const terminal of terminals) {
      if (terminal.status === 'exited' || terminal.label !== label) {
        continue;
      }
      if (best === null || terminal.scrollbackSeq > best.scrollbackSeq) {
        best = terminal;
      }
    }
    return best;
  }

  /** Reports a stream that was rejected with 401. */
  notifyUnauthorized(authorizationToken: string): void {
    this.terminalApi.notifyUnauthorized(authorizationToken);
  }

  private authSession(): ApiAuth {
    const serverUrl: string = this.sessionStore.readServerUrl();
    const accessToken: string = this.sessionStore.readAccessToken();
    if (serverUrl.length === 0 || accessToken.length === 0) {
      throw new Error('Sign in again to open terminal.');
    }
    return new ApiAuth(serverUrl, accessToken);
  }
}

/**
 * Android's `uniqueTerminalLabel`: a prefix, the id truncated to fit, and the id's
 * Java hash in hexadecimal.
 *
 * The hash is part of the label, so it has to match byte for byte; Java's
 * `String.hashCode` is a signed 32-bit accumulator that `toUInt()` then prints
 * unsigned, which is what the two helpers below rebuild.
 */
export function uniqueTerminalLabel(prefix: string, id: string): string {
  const hash: string = unsignedHex(javaHashCode(id));
  const maxIdLength: number = TERMINAL_LABEL_MAX_CHARS - prefix.length - hash.length - 2;
  const trimmedId: string = id.substring(0, Math.max(maxIdLength, 8));
  return `${prefix} ${trimmedId} ${hash}`;
}

/** Java `String.hashCode`, as a signed 32-bit integer. */
export function javaHashCode(value: string): number {
  let hash: number = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Kotlin's `Int.toUInt().toString(16)`. */
export function unsignedHex(value: number): string {
  return value >= 0 ? value.toString(16) : (value + 0x100000000).toString(16);
}
