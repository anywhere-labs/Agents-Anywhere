// ported from effi-crew cloud/agentd/src/workspace/files.ts @30f8334 (fsError), with v2 connector/local error codes.

/** A coded workspace failure; `code` is what the caller sees (v2 used `stale` for a failed `ifMatch`). */
export class WorkspaceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export const invalid = (message: string): WorkspaceError => new WorkspaceError('invalid_argument', message)
export const notFound = (message: string): WorkspaceError => new WorkspaceError('not_found', message)

/** A file system error as the coded error the workspace methods return. */
export function fsError(error: unknown, path: string, action = 'read'): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOENT':
      return notFound(`path not found: ${path}`)
    case 'ENOTDIR':
      return invalid(`not a directory: ${path}`)
    case 'EISDIR':
      return invalid(`is a directory, not a file: ${path}`)
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new WorkspaceError('permission_denied', `no permission to ${action}: ${path}`)
    case 'ELOOP':
      return invalid(`symbolic link loop: ${path}`)
    case 'EEXIST':
      return new WorkspaceError('already_exists', `already exists: ${path}`)
    case 'ENOSPC':
    case 'EDQUOT':
      return new WorkspaceError('resource_exhausted', `no space left: ${path}`, { reason: 'no_space' })
    case 'ENAMETOOLONG':
      return invalid(`path too long: ${path}`)
    default:
      return error
  }
}
