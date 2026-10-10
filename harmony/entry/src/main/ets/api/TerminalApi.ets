import { HttpTransport } from './HttpTransport';
import { encodeUrlComponent, webSocketApiUrl } from './ApiUrls';
import { parseRemoteTerminal, RemoteTerminal, RemoteTerminalDto } from './TerminalDtos';

/**
 * Terminal client.
 *
 * Port of `api/TerminalApi.kt`.
 *
 * A terminal is created *inside* a connector (`terminals-v2`, rooted at `root`),
 * so the Server keeps owning which directory the shell starts in. Both the
 * create and the list call answer with a `{ "result": … }` envelope; the close
 * call answers with an empty body.
 */

export class TerminalApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** `POST /connectors/{id}/terminals-v2?root=…`. */
  async createTerminal(
    serverUrl: string,
    token: string,
    deviceId: string,
    root: string,
    cols: number,
    rows: number,
    ephemeralGroupId: string,
    label: string,
    cwd: string = '.',
  ): Promise<RemoteTerminal> {
    const request: CreateTerminalRequest = {
      cols: cols,
      rows: rows,
      cwd: cwd,
      ephemeralGroupId: ephemeralGroupId,
      label: label,
    };
    const body: Object = await this.transport.postJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/terminals-v2?root=${encodeUrlComponent(root)}`,
      token,
      request,
    );
    const envelope: CreateTerminalEnvelope = body as CreateTerminalEnvelope;
    return parseRemoteTerminal(envelope.result === undefined
      ? {} as RemoteTerminalDto
      : envelope.result);
  }

  /** `GET /connectors/{id}/terminals-v2`, used to find a reusable terminal. */
  async listTerminals(
    serverUrl: string,
    token: string,
    deviceId: string,
  ): Promise<RemoteTerminal[]> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}/terminals-v2`, token,
    );
    const envelope: ListTerminalsEnvelope = body as ListTerminalsEnvelope;
    const terminals: RemoteTerminalDto[] = envelope.result === undefined
      || envelope.result.terminals === undefined
      ? []
      : envelope.result.terminals;
    const parsed: RemoteTerminal[] = [];
    for (const dto of terminals) {
      if (dto !== null && dto !== undefined) {
        parsed.push(parseRemoteTerminal(dto));
      }
    }
    return parsed;
  }

  /** `DELETE /connectors/{id}/terminals-v2/{terminalId}`. */
  async closeTerminal(
    serverUrl: string,
    token: string,
    deviceId: string,
    terminalId: string,
  ): Promise<void> {
    await this.transport.deleteJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/terminals-v2/${encodeUrlComponent(terminalId)}`,
      token,
    );
  }

  /**
   * The stream endpoint, as a WebSocket URL.
   *
   * The bearer token travels as a query parameter rather than a header, because
   * the platform WebSocket API cannot set one.
   */
  streamUrl(
    serverUrl: string,
    token: string,
    deviceId: string,
    terminalId: string,
    fromSeq: number = 0,
  ): string {
    return webSocketApiUrl(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/terminals-v2/${encodeUrlComponent(terminalId)}/stream`
        + `?fromSeq=${fromSeq}&token=${encodeUrlComponent(token)}`,
    );
  }

  /** Reports a stream that was rejected with 401, so the app can sign out. */
  notifyUnauthorized(token: string): void {
    this.transport.notifyUnauthorizedToken(token);
  }
}

interface CreateTerminalRequest {
  cols: number;
  rows: number;
  cwd: string;
  ephemeralGroupId: string;
  label: string;
}

interface CreateTerminalEnvelope {
  result?: RemoteTerminalDto;
}

interface ListTerminalsResult {
  terminals?: RemoteTerminalDto[];
}

interface ListTerminalsEnvelope {
  result?: ListTerminalsResult;
}
