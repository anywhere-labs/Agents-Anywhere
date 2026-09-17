import { HttpTransport } from './HttpTransport';
import { encodeUrlComponent } from './ApiUrls';
import {
  parseRemoteDirectory, parseRemoteTextFile, RemoteDirectory, RemoteDirectoryDto,
  RemoteTextFile, RemoteTextFileDto,
} from './FilesDtos';

/**
 * File system client.
 *
 * Port of `api/FilesApi.kt`.
 *
 * Both reads go through the connector that owns the device, so the Server is the
 * one enforcing that the app can only see files under a root it was given.
 * `listFiles` unwraps the `{ "result": … }` envelope; `readText` answers with the
 * file object itself and takes its root as a query parameter.
 */

export class FilesApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** `POST /connectors/{id}/fs/list`. */
  async listFiles(
    serverUrl: string,
    token: string,
    deviceId: string,
    root: string,
    path: string = '.',
  ): Promise<RemoteDirectory> {
    const request: ListFilesRequest = { root: root, path: path };
    const body: Object = await this.transport.postJson(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}/fs/list`, token, request,
    );
    // The response is `{ result: … }`; a missing envelope reads as an empty
    // directory rather than an error, which is what Android's `optJSONObject` does.
    const envelope: ListFilesEnvelope = body as ListFilesEnvelope;
    const directory: RemoteDirectoryDto = envelope.result === undefined
      ? {} as RemoteDirectoryDto
      : envelope.result;
    return parseRemoteDirectory(directory, root);
  }

  /** `POST /connectors/{id}/fs/readText?root=…`. */
  async readTextFile(
    serverUrl: string,
    token: string,
    deviceId: string,
    root: string,
    path: string,
    maxBytes: number = DEFAULT_MAX_BYTES,
  ): Promise<RemoteTextFile> {
    const request: ReadTextRequest = { path: path, maxBytes: maxBytes };
    const body: Object = await this.transport.postJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/fs/readText?root=${encodeUrlComponent(root)}`,
      token, request,
    );
    return parseRemoteTextFile(body as RemoteTextFileDto);
  }
}

/** Android's default read cap: one mebibyte. */
export const DEFAULT_MAX_BYTES: number = 1048576;

interface ListFilesRequest {
  root: string;
  path: string;
}

interface ListFilesEnvelope {
  result?: RemoteDirectoryDto;
  serverTime?: string;
}

interface ReadTextRequest {
  path: string;
  maxBytes: number;
}
