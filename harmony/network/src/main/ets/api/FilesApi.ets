import { ApiClient } from './ApiClient';
import { objGetBool, objGetNumber, objGetOptNumber, objGetOptString, objGetRecord, objGetString } from 'common';

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  type: string;
  size: number | null;
}

export interface RemoteDirectory {
  path: string;
  entries: RemoteDirectoryEntry[];
  truncated: boolean;
  targetType: string;
}

export interface RemoteTextFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  encoding: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  serverTime: string;
}

// Result of POST /connectors/{connectorId}/fs/read: the connector file
// metadata plus a one-shot transfer URL that streams the raw bytes.
export interface RemoteAgentFileDownload {
  path: string;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
  transferId: string;
  token: string;
  downloadUrl: string;
}

export class FilesApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async listFiles(serverUrl: string, authorizationToken: string, deviceId: string, root: string,
    path: string = '.'): Promise<RemoteDirectory> {
    const body: Record<string, Object> = {
      'root': root,
      'path': path
    };
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/fs/list`, body, authorizationToken);
    const result = objGetRecord(response, 'result');
    const resultRecord: Record<string, Object> = result === null ? {} : result;
    const entries: RemoteDirectoryEntry[] = [];
    const rawEntries = resultRecord['entries'];
    if (Array.isArray(rawEntries)) {
      const entryList = rawEntries as Object[];
      for (const value of entryList) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          continue;
        }
        const entry = value as Record<string, Object>;
        const name = objGetOptString(entry, 'name');
        const directoryEntry: RemoteDirectoryEntry = {
          name: name === null ? 'Untitled' : name,
          path: objGetString(entry, 'path', ''),
          type: objGetString(entry, 'type', 'other'),
          size: objGetOptNumber(entry, 'size')
        };
        entries.push(directoryEntry);
      }
    }
    const directory: RemoteDirectory = {
      path: objGetString(resultRecord, 'path', root),
      entries: entries,
      truncated: objGetBool(resultRecord, 'truncated', false),
      targetType: objGetString(resultRecord, 'targetType', 'directory')
    };
    return directory;
  }

  async readTextFile(serverUrl: string, authorizationToken: string, deviceId: string, root: string,
    path: string, maxBytes: number = 1048576): Promise<RemoteTextFile> {
    const body: Record<string, Object> = {
      'path': path,
      'maxBytes': maxBytes
    };
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/fs/readText?root=${encodeURIComponent(root)}`,
      body, authorizationToken);
    const name = objGetOptString(response, 'name');
    const textFile: RemoteTextFile = {
      path: objGetString(response, 'path', ''),
      name: name === null ? 'Untitled' : name,
      size: objGetNumber(response, 'size', 0),
      sha256: objGetString(response, 'sha256', ''),
      encoding: objGetString(response, 'encoding', 'utf8'),
      content: objGetString(response, 'content', ''),
      truncated: objGetBool(response, 'truncated', false),
      binary: objGetBool(response, 'binary', false),
      serverTime: objGetString(response, 'serverTime', '')
    };
    return textFile;
  }

  // Session agent files (Android parity: FilesController.listFiles called with
  // the session's connectorId and the session cwd as root). Same
  // POST /connectors/{connectorId}/fs/list contract as listFiles above.
  async listSessionAgentFiles(serverUrl: string, authorizationToken: string, connectorId: string,
    workspaceRoot: string, path: string = '.'): Promise<RemoteDirectory> {
    return this.listFiles(serverUrl, authorizationToken, connectorId, workspaceRoot, path);
  }

  // Session agent text preview (Android parity: FilesController.readTextFile
  // with the session's connectorId and the session cwd as root). Same
  // POST /connectors/{connectorId}/fs/readText?root=... contract.
  async readSessionAgentTextFile(serverUrl: string, authorizationToken: string, connectorId: string,
    workspaceRoot: string, path: string, maxBytes: number = 1048576): Promise<RemoteTextFile> {
    return this.readTextFile(serverUrl, authorizationToken, connectorId, workspaceRoot, path, maxBytes);
  }

  // POST /connectors/{connectorId}/fs/read?root=... — prepare a transfer-based
  // download for a file inside the session workspace. The returned downloadUrl
  // is a server-relative path that streams the raw bytes without extra auth.
  async requestSessionAgentFileDownload(serverUrl: string, authorizationToken: string,
    connectorId: string, workspaceRoot: string, path: string): Promise<RemoteAgentFileDownload> {
    const body: Record<string, Object> = {
      'path': path
    };
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(connectorId)}/fs/read?root=${encodeURIComponent(workspaceRoot)}`,
      body, authorizationToken);
    const result = objGetRecord(response, 'result');
    const resultRecord: Record<string, Object> = result === null ? {} : result;
    const name = objGetOptString(resultRecord, 'name');
    const download: RemoteAgentFileDownload = {
      path: objGetString(resultRecord, 'path', path),
      name: name === null ? 'Untitled' : name,
      size: objGetNumber(resultRecord, 'size', 0),
      sha256: objGetString(resultRecord, 'sha256', ''),
      mediaType: objGetString(resultRecord, 'mediaType', 'application/octet-stream'),
      transferId: objGetString(resultRecord, 'transferId', ''),
      token: objGetString(resultRecord, 'token', ''),
      downloadUrl: objGetString(resultRecord, 'downloadUrl', '')
    };
    return download;
  }
}
