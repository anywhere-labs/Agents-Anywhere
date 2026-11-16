// 工作区：文件、Shell 任务、端口发现与附件（终端在单独的模块里）。

import { FileOps } from './files.js'
import type { Params } from './params.js'
import { ShellOps } from './shell.js'

export { AttachmentCache, safeFileName, type AttachmentSource, type FetchFile, type LocalAttachment } from './attachments.js'
export { WorkspaceError, fsError } from './errors.js'
export { FileOps, mimeOf, type DirEntry, type PreparedDownload, type ReadDirResult, type ReadTextResult, type WriteFileResult } from './files.js'
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
export function workspaceMethods(files: FileOps, shell: ShellOps): Readonly<Record<string, WorkspaceHandler>> {
  return {
    'fs.readDir': params => files.readDir(params),
    'fs.readText': params => files.readText(params),
    'fs.writeFile': params => files.writeFile(params),
    'fs.prepareDownload': params => files.prepareDownload(params),
    'shell.exec': params => shell.exec(params),
    'shell.task.start': params => shell.taskStart(params),
    'shell.task.cancel': params => shell.taskCancel(params),
  }
}
