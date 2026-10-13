import { FilesApi } from '../../api/FilesApi';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import {
  FilesDirectory, TextFile, toFilesDirectory,
} from './RemoteFileNavigation';

/**
 * File browsing workflows.
 *
 * Port of `feature/files/FilesController.kt`.
 *
 * Both calls need an account, and both report the Server's message rather than a
 * generic one; the screens show it inline in the list or in the preview card.
 */
export class FilesController {
  private readonly filesApi: FilesApi;
  private readonly sessionStore: AuthSessionStore;

  constructor(filesApi: FilesApi, sessionStore: AuthSessionStore) {
    this.filesApi = filesApi;
    this.sessionStore = sessionStore;
  }

  /** Lists one directory. Throws when the account or the request is unusable. */
  async listFiles(connectorId: string, root: string, path: string = '.'): Promise<FilesDirectory> {
    const directory = await this.filesApi.listFiles(
      this.serverUrl(), this.token(), connectorId, root, path,
    );
    return toFilesDirectory(directory.path, directory.entries);
  }

  /** Reads a text file, capped by the Server's own limit. */
  async readTextFile(connectorId: string, root: string, path: string): Promise<TextFile> {
    const file = await this.filesApi.readTextFile(
      this.serverUrl(), this.token(), connectorId, root, path,
    );
    return {
      path: file.path,
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      encoding: file.encoding,
      content: file.content,
      truncated: file.truncated,
      binary: file.binary,
    };
  }

  private serverUrl(): string {
    const value: string = this.sessionStore.readServerUrl();
    if (value.length === 0) {
      throw new Error('Sign in again to browse files.');
    }
    return value;
  }

  private token(): string {
    const value: string = this.sessionStore.readAccessToken();
    if (value.length === 0) {
      throw new Error('Sign in again to browse files.');
    }
    return value;
  }
}
