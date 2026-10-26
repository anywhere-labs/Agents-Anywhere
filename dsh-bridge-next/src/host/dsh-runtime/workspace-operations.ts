import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { MeshCallError, mutates, query, service, z } from 'meshcall'
import { readJson, writeJson } from '../storage/files.js'
import type { OperationRecord, OperationRequest, OperationResult } from '../generated/operations.js'
import { canonicalJson, digest } from './identity.js'
import { json } from './types.js'
import { BridgeError } from './errors.js'
import type { NativeRuntime } from './native.js'
import { callScope, type CallScope } from './bridge-service.js'

const requestSchema = z.object({
  operationId: z.string().min(1).max(128), type: z.literal('workspace.create').default('workspace.create'),
  server: z.string().min(1).max(512), userId: z.string().min(1).max(128),
  connectorId: z.string().min(1).max(128), runtimeId: z.string().min(1).max(128), runtime: z.string().min(1).max(64),
  configRevision: z.int().nonnegative(), name: z.string().min(1).max(512), path: z.string().min(1).max(8192),
}).strict()
const resultSchema = z.object({ nativeProjectId: z.string().min(1), name: z.string().optional(),
  roots: z.array(z.string()).optional(), identityKind: z.string().optional() })
const recordSchema = z.object({ request: requestSchema,
  status: z.enum(['queued', 'accepted', 'running', 'reconciling', 'succeeded', 'failed', 'unknown']),
  result: resultSchema.nullable().optional(), message: z.string().nullable().optional(), resultReceived: z.boolean().optional() })

/** One durable receipt per operation; never infer success from an equal path/name. */
export class WorkspaceOperations {
  private readonly tasks = new Map<string, Promise<void>>()
  private admission: Promise<unknown> = Promise.resolve()
  private execution: Promise<unknown> = Promise.resolve()
  constructor(private readonly native: NativeRuntime, private readonly directory: string) {}
  private path(id: string): string { return join(this.directory, `${digest(id)}.json`) }
  private async read(id: string): Promise<OperationRecord | null> {
    const value = await readJson<OperationRecord>(this.path(id))
    if (value && value.request.operationId !== id) throw new Error('Operation receipt identity mismatch')
    return value ? recordSchema.parse(value) as OperationRecord : null
  }
  private write(record: OperationRecord): Promise<void> { return writeJson(this.path(record.request.operationId), record) }

  submit(request: OperationRequest): Promise<OperationRecord> {
    const admitted = this.admission.then(async () => {
      request = requestSchema.parse(request)
      const prior = await this.read(request.operationId)
      if (prior) {
        if (canonicalJson(json(prior.request)) !== canonicalJson(json(request))) throw new MeshCallError('operation_conflict', 'Operation ID has different parameters')
        return prior
      }
      if (this.tasks.size >= 256) throw new MeshCallError('resource_exhausted', 'Workspace operation queue is full')
      const receipt: OperationRecord = { request, status: 'accepted' }
      await this.write(receipt)
      this.schedule(receipt)
      return receipt
    })
    this.admission = admitted.catch(() => undefined)
    return admitted
  }
  async get(id: string): Promise<OperationRecord | null> {
    // Do not observe a partially admitted operation while a duplicate submits.
    await this.admission
    const record = await this.read(id)
    if (record?.status === 'accepted' || record?.status === 'queued') this.schedule(record)
    else if (record && ['running', 'reconciling'].includes(record.status) && !this.tasks.has(id)) {
      record.status = 'unknown'
      record.message = '原生调用可能已完成，需要人工核对；不会自动重复创建。'
      await this.write(record)
    }
    return record
  }
  async ack(id: string): Promise<OperationRecord | null> {
    const record = await this.get(id)
    if (record && ['succeeded', 'failed', 'unknown'].includes(record.status)) {
      record.resultReceived = true
      await this.write(record)
    }
    return record
  }
  private schedule(record: OperationRecord): void {
    const id = record.request.operationId
    if (this.tasks.has(id)) return
    const task = this.execution.then(() => this.execute(record))
    this.execution = task.catch(() => undefined)
    this.tasks.set(id, task)
    void task.catch(error => this.native.diagnostics.log('error', 'workspace.operation_persistence_failed', { type: String(error?.constructor?.name) }))
      .finally(() => this.tasks.delete(id))
  }
  private async execute(record: OperationRecord): Promise<void> {
    const request = record.request
    // Validation before running cannot have changed native state.
    let path: string
    try {
      if (!isAbsolute(request.path)) throw new BridgeError('INVALID_PARAMS', 'Choose an absolute directory')
      path = await realpath(request.path)
      if (!(await stat(path)).isDirectory()) throw new BridgeError('INVALID_PARAMS', 'Choose an existing directory')
      if (!this.native.ctx.get('workspaceRegistry')) throw new BridgeError('UNSUPPORTED_OPERATION', 'Workspace registry is unavailable')
    } catch (error) {
      record.status = 'failed'; record.message = String(error instanceof Error ? error.message : error)
      await this.write(record); return
    }
    record.status = 'running'
    await this.write(record)
    try {
      const workspace = await this.native.ctx.workspaceRegistry.create(path, request.name)
      record.result = { nativeProjectId: workspace.id, name: workspace.title, roots: [workspace.path], identityKind: 'native' }
      record.status = 'succeeded'
    } catch (error) {
      record.status = 'unknown'; record.message = String(error instanceof Error ? error.message : error)
    }
    await this.write(record)
  }
  async legacy(name: string, path: string, id: string, namespace: string): Promise<OperationResult> {
    let record = await this.submit({ operationId: id, type: 'workspace.create', server: namespace,
      userId: namespace, connectorId: namespace, runtimeId: namespace, runtime: 'dsh', configRevision: 0, name, path })
    while (!['succeeded', 'failed', 'unknown'].includes(record.status)) {
      await new Promise(resolve => setTimeout(resolve, 100))
      record = (await this.get(id))!
    }
    if (!record.result || record.status !== 'succeeded') throw new BridgeError('PERSISTENCE_ERROR', record.message ?? 'Native result unknown')
    return record.result
  }
}

@service('aa.dsh.v2.Operations', { description: 'Durable native workspace operations.' })
export class WorkspaceOperationsService {
  constructor(private readonly native: NativeRuntime | undefined) {}
  private require(namespace: string): WorkspaceOperations {
    if (!this.native) throw new MeshCallError('UNSUPPORTED_OPERATION', 'Native workspace registry is unavailable')
    return this.native.workspaceOperationsFor(namespace)
  }
  @query({ description: 'Check the local operation protocol.', request: z.object({}), response: z.object({ protocolVersion: z.literal('1.0') }) })
  async ping(): Promise<{ protocolVersion: '1.0' }> { return { protocolVersion: '1.0' } }
  @mutates({ description: 'Persist operation reception; execute independently of this call.',
    request: z.object({ request: requestSchema }), response: recordSchema, inject: [callScope] })
  async submit(input: { request: OperationRequest }, scope: CallScope): Promise<OperationRecord> {
    if (!scope.namespace || input.request.runtime !== 'dsh') throw new MeshCallError('INVALID_PARAMS', 'DSH operation scope required')
    return this.require(scope.namespace).submit(input.request)
  }
  @query({ description: 'Read a persistent operation receipt.', request: z.object({ operationId: z.string() }),
    response: recordSchema.nullable(), inject: [callScope] })
  async get(input: { operationId: string }, _scope: CallScope): Promise<OperationRecord | null> { return this.require(_scope.namespace).get(input.operationId) }
  @mutates({ description: 'Confirm upstream reception without deleting the receipt.', request: z.object({ operationId: z.string() }),
    response: recordSchema.nullable(), inject: [callScope] })
  async ackResult(input: { operationId: string }, _scope: CallScope): Promise<OperationRecord | null> { return this.require(_scope.namespace).ack(input.operationId) }
}
