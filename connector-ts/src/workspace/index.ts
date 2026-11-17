// 工作区：文件、Shell 任务、终端（node-pty）、端口发现与附件。

import { FileOps } from './files.js'
import type { Params } from './params.js'
import { ShellOps } from './shell.js'
import type { Terminals } from './terminals.js'

export { ATTACHMENT_META, AttachmentCache, safeFileName, type AttachmentCacheOptions, type AttachmentSource, type AttachmentStored, type FetchFile, type LocalAttachment, type OpenSealed, type StoredAttachment } from './attachments.js'
export { WorkspaceError, fsError } from './errors.js'
export { FILE_CHUNK_MAX_BYTES, FileOps, mimeOf, type DirEntry, type FileChunk, type PreparedDownload, type ReadDirResult, type ReadTextResult, type WriteFileResult } from './files.js'
export { MAX_DIR_ENTRIES, MAX_OUTPUT_CHARS, MAX_READ_TEXT_BYTES, type Params } from './params.js'
export * from './preview/index.js'
export { PortWatcher, listeningPorts, mergeByPort, parseLsof, parseNetstat, parseProcNetTcp, parseTasklist, type ListeningPort } from './ports.js'
export { RootPolicy, expandHome, realPathOf, rootsFromEnv, type RootPolicyOptions } from './roots.js'
export { ShellOps, type Notify, type ShellResult } from './shell.js'

export type WorkspaceHandler = (params: Params) => Promise<unknown>

/**
 * The v2 workspace methods by name (`fs.readDir`, `shell.exec`, ...), for whichever transport serves them. Their
 * request and response bodies are unchanged from v2; device-meshcall 1.0 does not name them yet.
 */
export function workspaceMethods(files: FileOps, shell: ShellOps, terminals?: Terminals): Readonly<Record<string, WorkspaceHandler>> {
  return {
    ...(terminals === undefined ? {} : {
      'terminal.create': (params: Params) => terminals.create(params),
      'terminal.write': (params: Params) => terminals.write(params),
      'terminal.resize': (params: Params) => terminals.resize(params),
      'terminal.close': (params: Params) => terminals.close(params),
      'terminal.rename': (params: Params) => terminals.rename(params),
      'terminal.setPersistent': (params: Params) => terminals.setPersistent(params),
      'terminal.list': (params: Params) => terminals.list(params),
      'terminal.release': (params: Params) => terminals.release(params),
      'terminal.snapshot': (params: Params) => terminals.snapshot(params),
    }),
    'fs.readDir': params => files.readDir(params),
    'fs.readText': params => files.readText(params),
    'fs.writeFile': params => files.writeFile(params),
    'fs.prepareDownload': params => files.prepareDownload(params),
    'fs.readRange': params => files.readRange(params),
    'shell.exec': params => shell.exec(params),
    'shell.task.start': params => shell.taskStart(params),
    'shell.task.cancel': params => shell.taskCancel(params),
  }
}
export {
  TERMINAL_SCROLLBACK_MAX_BYTES,
  Terminals,
  ensurePtyHelper,
  nodePtySpawner,
  type Pty,
  type SpawnPty,
  type TerminalOptions,
  type TerminalSink,
} from './terminals.js'
