import { ApiClient } from './ApiClient';
import { webSocketApiUrl } from 'common';
import { objGetArray, objGetNumber, objGetOptNumber, objGetOptString, objGetString, recordOrNull } from 'common';

export interface RemoteTerminal {
  terminalId: string;
  sessionId: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  purpose: string;
  pid: number | null;
  status: string;
  exitCode: number | null;
  scrollbackBytes: number;
  scrollbackSeq: number;
}

export class TerminalApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async createTerminal(serverUrl: string, authorizationToken: string, deviceId: string, root: string,
    cols: number, rows: number, cwd: string, ephemeralGroupId: string, label: string): Promise<RemoteTerminal> {
    const body: Record<string, Object> = {
      'cols': cols,
      'rows': rows,
      'cwd': cwd,
      'ephemeralGroupId': ephemeralGroupId,
      'label': label
    };
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/terminals-v2?root=${encodeURIComponent(root)}`,
      body, authorizationToken);
    return parseRemoteTerminal(requireResult(response));
  }

  async listTerminals(serverUrl: string, authorizationToken: string,
    deviceId: string): Promise<RemoteTerminal[]> {
    const response = await this.client.getJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/terminals-v2`, authorizationToken);
    const result = requireResult(response);
    const terminals: RemoteTerminal[] = [];
    const rawTerminals = result['terminals'];
    if (Array.isArray(rawTerminals)) {
      const list = rawTerminals as Object[];
      for (const value of list) {
        const record = recordOrNull(value);
        if (record !== null) {
          terminals.push(parseRemoteTerminal(record));
        }
      }
    }
    return terminals;
  }

  async closeTerminal(serverUrl: string, authorizationToken: string, deviceId: string,
    terminalId: string): Promise<void> {
    await this.client.deleteJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/terminals-v2/${encodeURIComponent(terminalId)}`,
      authorizationToken);
  }

  streamUrl(serverUrl: string, deviceId: string, terminalId: string, fromSeq: number = 0): string {
    return webSocketApiUrl(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/terminals-v2/${encodeURIComponent(terminalId)}` +
      `/stream?fromSeq=${fromSeq}`);
  }

  // terminals-v2 has no dedicated resize endpoint; the remote shell is resized
  // with a stream resize frame (mirrors android's sendRemoteResizeNow).
  resizeFrame(cols: number, rows: number): string {
    const frame: Record<string, Object> = {
      'type': 'resize',
      'cols': cols,
      'rows': rows
    };
    return JSON.stringify(frame);
  }

  inputFrame(text: string): string {
    const frame: Record<string, Object> = {
      'type': 'input',
      'data': text
    };
    return JSON.stringify(frame);
  }
}

function requireResult(response: Record<string, Object>): Record<string, Object> {
  const result = response['result'];
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return result as Record<string, Object>;
  }
  throw new Error('The server returned an invalid response.');
}

function parseRemoteTerminal(value: Record<string, Object>): RemoteTerminal {
  const label = objGetOptString(value, 'label');
  const terminal: RemoteTerminal = {
    terminalId: objGetString(value, 'terminalId', ''),
    sessionId: objGetString(value, 'sessionId', ''),
    label: label === null || label.length === 0 ? 'zsh' : label,
    cwd: objGetString(value, 'cwd', ''),
    cols: objGetNumber(value, 'cols', 80),
    rows: objGetNumber(value, 'rows', 24),
    purpose: objGetString(value, 'purpose', 'user'),
    pid: objGetOptNumber(value, 'pid'),
    status: objGetString(value, 'status', 'starting'),
    exitCode: objGetOptNumber(value, 'exitCode'),
    scrollbackBytes: objGetNumber(value, 'scrollbackBytes', 0),
    scrollbackSeq: objGetNumber(value, 'scrollbackSeq', 0)
  };
  return terminal;
}
