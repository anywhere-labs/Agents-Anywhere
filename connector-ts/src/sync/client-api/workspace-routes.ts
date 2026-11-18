// ported from Agents-Anywhere v2 server/agent_server/api/connector_files.py @4c8012369 (connector_fs_list, connector_fs_read, connector_fs_read_text, connector_fs_write, connector_fs_preview_read_text, connector_fs_preview_read)
// ported from Agents-Anywhere v2 server/agent_server/api/connector_shell.py @4c8012369 (connector_shell_exec, connector_shell_task_start, connector_shell_task_wait)
// ported from Agents-Anywhere v2 server/agent_server/api/connector_terminal.py @4c8012369 (connector_terminal_create_v2, connector_terminal_list_v2, connector_terminal_rename_v2, connector_terminal_set_persistence_v2, connector_terminal_close_v2, connector_terminal_resize_v2, connector_terminal_write_v2, connector_terminal_snapshot_v2)
// ported from Agents-Anywhere v2 server/agent_server/services/terminal.py @4c8012369 (TerminalService.create_for_connector, list_for_connector, rename_for_connector, close_for_connector, resize_for_connector)
// ported from Agents-Anywhere v2 server/agent_server/api/connector_runtimes.py @4c8012369 (get_connector_runtime_model_catalog, get_connector_runtime_permission_catalog, get_connector_runtime_commands)
import type { TunnelApiResponse } from '../../application/inbound/tunnel-api.js'
import { TunnelHttpError, int, invalid, isRecord, notFound, okBody, record, text, withStatus, type Route } from './http.js'
import { listingPath, resolveWorkspacePath } from './paths.js'
import { TerminalRoots, browseScope, modelCatalogView, permissionCatalogView, terminalLabel, terminalV1View, terminalV2View } from './views.js'

/** A workspace handler by client method name (`fs.readDir`, `terminal.create`, ...). */
export type WorkspaceCall = (params: Record<string, unknown>) => Promise<unknown>

/** A Runtime instance's own catalogs, before or without a session (`Runtime.catalogs()` of a started instance). */
export interface RuntimeCatalogs {
  /** Null when the instance is not on this device. */
  catalogs(runtimeId: string): Promise<{ readonly runtimeType: string; readonly catalogs: Record<string, unknown> | null } | null>
}

/** A file download the Server set up: where the device sends the bytes and how the client fetches them. */
export interface TransferFacts {
  readonly transferId: string
  readonly token: string
  /** The Server path the device uploads to (`/api/v3/device/transfers/{transferId}`). */
  readonly path: string
  /** The URL the client downloads from; default the `fs/transfers` route of this device. */
  readonly downloadUrl?: string
}

/** The file a preview token opened, as the Server verified it. */
export interface PreviewFacts {
  readonly root: string
  readonly path: string
}

export interface WorkspaceRouteDeps {
  readonly deviceId: string
  readonly now: () => string
  readonly workspace?: Readonly<Record<string, WorkspaceCall>>
  /** `fs.uploadPreparedDownload`: sends a prepared download to the Server's transfer relay in the background. */
  readonly transferUpload?: (params: Record<string, unknown>) => Promise<unknown>
  readonly runtimes?: RuntimeCatalogs
  /** The platform the workspace runs on (an empty path lists the drives on Windows). */
  readonly platform: NodeJS.Platform
  readonly newTerminalId: () => string
  /** Ids of background shell tasks (`sht_…`). */
  readonly newShellTaskId: () => string
}

/** Where a terminal route works: the scope its terminals belong to and the root relative paths start from. */
interface TerminalScope {
  readonly scope: string
  readonly root: string | null
}

const READ_TEXT_FIELDS = ['path', 'name', 'size', 'sha256', 'encoding', 'content', 'truncated', 'binary'] as const

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value)
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = source[key] ?? null
  return out
}

const terminalGone = (): TunnelHttpError => new TunnelHttpError(404, 'terminal_not_found', 'terminal not found')

/** Longest `timeoutMs` of `shell/exec`, a shell task and its `wait` (`MAX_HOLD_MS` of the route table). */
const MAX_SHELL_TIMEOUT_MS = 300_000
const DEFAULT_WAIT_MS = 120_000
/** Statuses of a shell task's own failures; any other workspace failure is a 502. */
const SHELL_TASK_STATUS: Readonly<Record<string, number>> = { shell_task_not_found: 404, shell_task_wait_timeout: 408, resource_exhausted: 503 }

/**
 * The device routes (`connectors/{id}/…`, the preview reads and the session terminals): files, shell, terminals and
 * Runtime catalogs. Paths are resolved against the root the client chose, like the Server did; a workspace failure
 * is a 502 with the workspace's code and message, as the Server answered for the same routes.
 */
export class WorkspaceRoutes {
  public readonly roots = new TerminalRoots()

  public constructor(private readonly deps: WorkspaceRouteDeps) {}

  private async call(method: string, params: Record<string, unknown>, scope = browseScope(this.deps.deviceId), keep: Readonly<Record<string, number>> = {}): Promise<unknown> {
    const handler = this.deps.workspace?.[method]
    if (handler === undefined) throw new TunnelHttpError(501, 'not_implemented', `${method} is not available on this device`)
    return withStatus(502, () => handler({ sessionId: scope, ...params }), keep)
  }

  /** A terminal call whose missing terminal is a 404, as the Server's relay answered. */
  private async terminalCall(method: string, params: Record<string, unknown>, scope?: string): Promise<unknown> {
    try {
      return await this.call(method, params, scope)
    } catch (error) {
      if (error instanceof TunnelHttpError && error.code === 'terminal_not_found') throw terminalGone()
      throw error
    }
  }

  private root(route: Route): string {
    const root = route.query.get('root') ?? text(route.body.root)
    if (root === null || root.trim() === '') throw invalid('root is required')
    return root
  }

  private resolve(root: string, raw: string): string {
    try {
      return resolveWorkspacePath(root, raw)
    } catch {
      throw invalid('root is required')
    }
  }

  private requiredPath(body: Record<string, unknown>): string {
    const path = text(body.path)
    if (path === null) throw invalid('path is required')
    return path
  }

  // ---------------------------------------------------------------------------------------- connectors/{id}/…

  /**
   * `preview`: the file of a preview token the Server verified (`server.preview` of a `Client/call`). The Server
   * forwards preview reads as `fs/readText` / `fs/read`; with it, those two routes read that file and ignore the
   * request's own root and path.
   */
  public async device(route: Route, transfer: TransferFacts | null, preview: PreviewFacts | null = null): Promise<TunnelApiResponse> {
    const rest = route.segments.slice(2)
    const body = route.body
    const action = `${route.method} ${rest.join('/')}`
    if (preview !== null && (action === 'POST fs/readText' || action === 'POST fs/read')) {
      return action === 'POST fs/readText' ? this.readText(preview.root, preview.path, body.maxBytes) : this.download(preview.root, preview.path, transfer)
    }
    switch (action) {
      case 'POST fs/list': {
        if (!route.query.has('root') && body.root === undefined && body.path === undefined) {
          return okBody(await this.call('fs.readDir', { defaultWorkspace: true }))
        }
        const root = this.root(route)
        const raw = body.path === undefined || body.path === null ? '.' : body.path
        if (typeof raw !== 'string') throw invalid('path must be a string')
        return okBody(await this.call('fs.readDir', { root, path: listingPath(this.deps.platform, root, raw) }))
      }
      case 'POST fs/readText':
        return this.readText(this.root(route), this.resolve(this.root(route), this.requiredPath(body)), body.maxBytes)
      case 'POST fs/write': {
        const root = this.root(route)
        if (typeof body.content !== 'string') throw invalid('content is required')
        return okBody(await this.call('fs.writeFile', {
          root,
          path: this.resolve(root, this.requiredPath(body)),
          content: body.content,
          encoding: body.encoding ?? 'utf8',
          ...(text(body.ifMatch) !== null ? { ifMatch: body.ifMatch } : {}),
        }))
      }
      case 'POST fs/read': {
        const root = this.root(route)
        return this.download(root, this.resolve(root, this.requiredPath(body)), transfer)
      }
      case 'GET fs/read': {
        // The secure channel reads files in chunks (no relay between the device and the client).
        const root = this.root(route)
        return {
          status: 200,
          body: await this.call('fs.readRange', {
            root,
            path: this.resolve(root, route.query.get('path') ?? ''),
            offset: int(route.query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
            length: int(route.query.get('length'), 8 * 1024 * 1024, 1, 8 * 1024 * 1024),
          }),
        }
      }
      case 'POST shell/exec':
        return okBody(await this.call('shell.exec', this.shellCommand(route)))
      case 'POST shell/tasks': {
        const task = await this.call('shell.task.start', { ...this.shellCommand(route), taskId: this.deps.newShellTaskId() }, undefined, SHELL_TASK_STATUS)
        return { status: 200, body: { ...record(task), serverTime: this.deps.now() } }
      }
      default:
        break
    }
    if (rest[0] === 'shell' && rest[1] === 'tasks' && rest.length === 4) {
      const taskId = rest[2]!
      if (route.method === 'GET' && rest[3] === 'wait') {
        const timeoutMs = int(route.query.get('timeoutMs'), DEFAULT_WAIT_MS, 1, MAX_SHELL_TIMEOUT_MS)
        const task = await this.call('shell.task.wait', { taskId, timeoutMs }, undefined, SHELL_TASK_STATUS)
        return { status: 200, body: { ...record(task), serverTime: this.deps.now() } }
      }
      if (route.method === 'POST' && rest[3] === 'cancel') {
        const task = await this.call('shell.task.cancel', { taskId }, undefined, SHELL_TASK_STATUS)
        return { status: 200, body: { ...record(task), serverTime: this.deps.now() } }
      }
    }
    const scope: TerminalScope = { scope: browseScope(this.deps.deviceId), root: route.query.get('root') ?? text(body.root) }
    if (rest[0] === 'terminals-v2') return this.terminalsV2(route, rest.slice(1), scope)
    if (rest[0] === 'terminals') return this.terminalsV1(route, rest.slice(1), scope)
    if (rest[0] === 'runtimes' && rest.length >= 3 && route.method === 'GET') return this.runtimeCatalog(rest[1]!, rest.slice(2).join('/'))
    throw notFound(`${route.method} connectors/{id}/${rest.join('/')} is not served by this device`)
  }

  /** The command of `shell/exec` and `shell/tasks` (`ShellExecRequest`), its cwd resolved against the root. */
  private shellCommand(route: Route): Record<string, unknown> {
    const root = this.root(route)
    const body = route.body
    const command = text(body.command)
    if (command === null) throw invalid('command is required')
    const timeoutMs = body.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SHELL_TIMEOUT_MS) throw invalid(`timeoutMs must be an integer in [1, ${MAX_SHELL_TIMEOUT_MS}]`)
    return { root, cwd: this.resolve(root, text(body.cwd) ?? '.'), command, timeoutMs }
  }

  /** `sessions/{id}/terminals*` (v1): terminals scoped to the session, rooted at its working directory. */
  public async sessionTerminals(route: Route, sessionId: string, cwd: string | null): Promise<TunnelApiResponse> {
    if (cwd === null || cwd === '') throw new TunnelHttpError(409, 'session_cwd_required', 'session cwd is required')
    return this.terminalsV1(route, route.segments.slice(3), { scope: sessionId, root: cwd })
  }

  private async readText(root: string, path: string, rawMax: unknown): Promise<TunnelApiResponse> {
    const maxBytes = rawMax === undefined || rawMax === null ? 1_048_576 : rawMax
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_194_304) throw invalid('maxBytes must be an integer in [1, 4194304]')
    const result = await this.call('fs.readText', { root, path, maxBytes })
    return { status: 200, body: { ...pick(result, READ_TEXT_FIELDS), serverTime: this.deps.now() } }
  }

  /**
   * `POST fs/read`: checks the file, answers its description with the transfer the Server allocated, and sends the
   * bytes to the Server's relay in the background.
   */
  private async download(root: string, path: string, transfer: TransferFacts | null): Promise<TunnelApiResponse> {
    if (transfer === null) throw new TunnelHttpError(409, 'transfer_required', 'a file download needs a transfer from the Server')
    const upload = this.deps.transferUpload
    if (upload === undefined) throw new TunnelHttpError(501, 'not_implemented', 'file downloads are not available on this device')
    const prepared = await this.call('fs.prepareDownload', { root, path })
    await withStatus(502, () => upload({ sessionId: browseScope(this.deps.deviceId), root, path, transferId: transfer.transferId, token: transfer.token, uploadUrl: transfer.path }))
    const downloadUrl = transfer.downloadUrl ?? `/api/v2/connectors/${encodeURIComponent(this.deps.deviceId)}/fs/transfers/${encodeURIComponent(transfer.transferId)}?token=${encodeURIComponent(transfer.token)}`
    return okBody({ ...record(prepared), transferId: transfer.transferId, token: transfer.token, downloadUrl })
  }

  // -------------------------------------------------------------------------------------------- terminals

  private async create(scope: TerminalScope, body: Record<string, unknown>, label: string | null): Promise<{ result: unknown; terminalId: string; root: string; cwd: string }> {
    if (scope.root === null || scope.root.trim() === '') throw invalid('root is required')
    const cols = body.cols === undefined ? 80 : body.cols
    const rows = body.rows === undefined ? 24 : body.rows
    if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || cols > 500) throw invalid('cols must be an integer in [1, 500]')
    if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 200) throw invalid('rows must be an integer in [1, 200]')
    const terminalId = this.deps.newTerminalId()
    const cwd = this.resolve(scope.root, text(body.cwd) ?? '.')
    const result = await this.call('terminal.create', {
      terminalId,
      root: scope.root,
      cwd,
      shell: body.shell ?? null,
      command: body.command ?? null,
      args: Array.isArray(body.args) ? body.args : [],
      profile: body.profile ?? null,
      cols,
      rows,
      env: record(body.env),
      label,
      persistent: body.persistent === true,
      outputTransport: 'relay',
    }, scope.scope)
    this.roots.remember(terminalId, scope.scope, scope.root, cwd, text(body.ephemeralGroupId))
    return { result, terminalId, root: scope.root, cwd }
  }

  private v2View(raw: unknown, scope: string, terminalId?: string): Record<string, unknown> {
    const id = terminalId ?? String(record(raw).terminalId ?? '')
    const where = this.roots.get(id)
    return terminalV2View(raw, { sessionId: scope, ...(terminalId !== undefined ? { terminalId } : {}), root: where?.root ?? null, cwd: where?.cwd ?? null }, this.deps.now())
  }

  private async listScope(scope: string): Promise<Record<string, unknown>[]> {
    const listed = record(await this.call('terminal.list', {}, scope))
    const terminals = Array.isArray(listed.terminals) ? listed.terminals.filter(isRecord) : []
    this.roots.prune(scope, new Set(terminals.map(item => String(item.terminalId ?? ''))))
    return terminals
  }

  private async terminalsV2(route: Route, rest: readonly string[], where: TerminalScope): Promise<TunnelApiResponse> {
    const body = route.body
    const scope = where.scope
    if (rest.length === 0) {
      if (route.method === 'POST') {
        const created = await this.create(where, body, text(body.label))
        const label = text(body.label) ?? 'Shell'
        return okBody(terminalV2View(created.result, { sessionId: scope, terminalId: created.terminalId, root: created.root, cwd: created.cwd, label, cols: body.cols as number | undefined ?? 80, rows: body.rows as number | undefined ?? 24 }, this.deps.now()))
      }
      if (route.method === 'GET') {
        const listed = record(await this.call('terminal.list', {}, scope))
        if (!Array.isArray(listed.terminals)) return okBody(listed)
        const terminals = listed.terminals.filter(isRecord)
        this.roots.prune(scope, new Set(terminals.map(item => String(item.terminalId ?? ''))))
        return okBody({ ...listed, terminals: terminals.map(item => this.v2View(item, scope)) })
      }
    }
    const terminalId = rest[0]!
    switch (`${route.method} ${rest.slice(1).join('/')}`) {
      case 'PATCH ': {
        const label = typeof body.label === 'string' ? body.label : ''
        if (label === '' || label.length > 64) throw invalid('label must be 1 to 64 characters')
        return okBody(this.v2View(await this.call('terminal.rename', { terminalId, label }, scope), scope, terminalId))
      }
      case 'PATCH persistence': {
        if (typeof body.persistent !== 'boolean') throw invalid('persistent must be a boolean')
        try {
          return okBody(this.v2View(await this.terminalCall('terminal.setPersistent', { terminalId, persistent: body.persistent }, scope), scope, terminalId))
        } catch (error) {
          if (error instanceof TunnelHttpError && error.status === 404) this.roots.forget(terminalId)
          throw error
        }
      }
      case 'DELETE ': {
        const result = await this.call('terminal.close', { terminalId }, scope)
        this.roots.forget(terminalId)
        return okBody(result)
      }
      case 'POST resize':
        return okBody(await this.terminalCall('terminal.resize', { terminalId, cols: body.cols, rows: body.rows }, scope))
      case 'POST write': {
        if (typeof body.dataBase64 !== 'string') throw invalid('dataBase64 is required')
        return okBody(await this.terminalCall('terminal.write', { terminalId, dataBase64: body.dataBase64 }, scope))
      }
      case 'GET snapshot': {
        const result = record(await this.terminalCall('terminal.snapshot', { terminalId, fromSeq: int(route.query.get('fromSeq'), 0, 0, Number.MAX_SAFE_INTEGER) }, scope))
        return okBody(isRecord(result.terminal) ? { ...result, terminal: this.v2View(result.terminal, scope, terminalId) } : result)
      }
      default:
        throw notFound(`${route.method} terminals-v2/${rest.join('/')} is not served by this device`)
    }
  }

  private v1View(raw: unknown, scope: string, terminalId: string): Record<string, unknown> {
    const where = this.roots.get(terminalId)
    return terminalV1View(raw, { sessionId: scope, terminalId, root: where?.root ?? null, cwd: where?.cwd ?? null, ephemeralGroupId: where?.ephemeralGroupId ?? null }, this.deps.now())
  }

  /** A terminal of `scope`, as listed now; a 404 for one of another scope or none. */
  private async requireTerminal(scope: string, terminalId: string): Promise<Record<string, unknown>> {
    const found = (await this.listScope(scope)).find(item => item.terminalId === terminalId)
    if (found === undefined) throw terminalGone()
    return found
  }

  /** The v1 terminal routes (`TerminalResponse`, `TerminalListResponse`), served by the same terminals as `terminals-v2`. */
  private async terminalsV1(route: Route, rest: readonly string[], where: TerminalScope): Promise<TunnelApiResponse> {
    const body = route.body
    const scope = where.scope
    const answer = (terminal: Record<string, unknown>): TunnelApiResponse => ({ status: 200, body: { terminal, serverTime: this.deps.now() } })
    if (rest.length === 0 && route.method === 'POST') {
      const group = text(body.ephemeralGroupId)
      const existing = (await this.listScope(scope)).filter(item => (this.roots.get(String(item.terminalId))?.ephemeralGroupId ?? null) === group).length
      const created = await this.create(where, body, terminalLabel(text(body.label), text(body.shell), existing))
      return answer(this.v1View(created.result, scope, created.terminalId))
    }
    if (rest.length === 0 && route.method === 'GET') {
      const terminals = (await this.listScope(scope)).map(item => this.v1View(item, scope, String(item.terminalId ?? '')))
      return { status: 200, body: { terminals, serverTime: this.deps.now() } }
    }
    const terminalId = rest[0] ?? ''
    switch (`${route.method} ${rest.slice(1).join('/')}`) {
      case 'PATCH ': {
        const label = typeof body.label === 'string' ? body.label.trim() : ''
        if (label === '' || label.length > 64) throw invalid('label must be 1 to 64 characters')
        await this.requireTerminal(scope, terminalId)
        return answer(this.v1View(await this.terminalCall('terminal.rename', { terminalId, label }, scope), scope, terminalId))
      }
      case 'DELETE ': {
        const view = this.v1View(await this.requireTerminal(scope, terminalId), scope, terminalId)
        await this.call('terminal.close', { terminalId }, scope)
        this.roots.forget(terminalId)
        return answer(view)
      }
      case 'POST resize': {
        await this.requireTerminal(scope, terminalId)
        const resized = record(await this.terminalCall('terminal.resize', { terminalId, cols: body.cols, rows: body.rows }, scope))
        if (resized.closed === true) {
          this.roots.forget(terminalId)
          throw terminalGone()
        }
        return answer(this.v1View(await this.requireTerminal(scope, terminalId), scope, terminalId))
      }
      default:
        throw notFound(`${route.method} terminals/${rest.join('/')} is not served by this device`)
    }
  }

  // --------------------------------------------------------------------------------------- Runtime catalogs

  private async runtimeCatalog(runtimeId: string, what: string): Promise<TunnelApiResponse> {
    if (!['catalogs/model', 'catalogs/permission', 'commands'].includes(what)) throw notFound(`runtimes/{id}/${what} is not served by this device`)
    const found = await this.deps.runtimes?.catalogs(runtimeId)
    if (found === null || found === undefined) throw new TunnelHttpError(404, 'runtime_not_found', 'runtime not found')
    const serverTime = this.deps.now()
    // Slash commands belong to sessions on a v3 device: a Runtime instance has none of its own.
    if (what === 'commands') return { status: 200, body: { commands: [], serverTime } }
    const catalogs = found.catalogs ?? {}
    const catalog = what === 'catalogs/model' ? modelCatalogView(catalogs.models, found.runtimeType) : permissionCatalogView(catalogs.permissions, found.runtimeType)
    return { status: 200, body: { catalog, serverTime } }
  }
}
