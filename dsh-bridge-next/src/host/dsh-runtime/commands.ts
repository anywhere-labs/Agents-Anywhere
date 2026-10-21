import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { BridgeError } from './errors.js'
import type { RuntimeConfiguration } from './configuration.js'
import type { NativeSessionSource } from './sessions/source.js'

interface CommandResult {
  command: string
  ok: boolean
  code?: string
  message?: string
  result: Record<string, unknown>
}
export interface CommandCapability {
  supported: boolean
  available: boolean
  reason?: string
  catalogRevision: string
}
const ONLINE_STATUSES = ['idle', 'running', 'waiting', 'pending', 'stopping', 'waiting_approval', 'error', 'blocked']

/** AA exposes only native compact; the registry owns its grammar and side effects. */
export class RuntimeCommands {
  private readonly instance = randomUUID()
  private revision = 0
  private readonly unwatch: () => void

  constructor(private ctx: Context, private configuration: RuntimeConfiguration,
    private source: NativeSessionSource, private changed: () => void) {
    this.unwatch = ctx.on('commands/change', () => this.invalidate(), { global: true })
  }

  invalidate(): void { this.revision++; this.changed() }
  close(): void { this.unwatch() }

  async capability(id?: SessionId): Promise<CommandCapability> {
    const catalogRevision = `${this.instance}:${this.revision}`
    const supported = Boolean(this.ctx.get('commands') && this.ctx.get('sessionController'))
    if (!supported) return { supported: false, available: false, catalogRevision,
      reason: 'DSH commands registry and Session Controller are required.' }
    if (id) {
      const state = await this.source.state(id)
      if (state.availability !== 'available') return { supported, available: false, catalogRevision,
        reason: `DSH commands are unavailable for this session (${state.reason ?? state.availability}).` }
      // Capability reads must not activate the session Agent; execution does that on demand.
    }
    return { supported, available: true, catalogRevision }
  }

  private registry() {
    const registry = this.ctx.get('commands')
    if (!registry || !this.ctx.get('sessionController')) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH commands registry and Session Controller are required.')
    return registry
  }

  private async agent(id: SessionId, signal: AbortSignal): Promise<Agent> {
    signal.throwIfAborted()
    const agent = await this.configuration.agent(id)
    signal.throwIfAborted()
    if (agent.id !== id || agent.session.id !== id) throw new BridgeError('INVALID_PARAMS', 'DSH resolved a different session Agent.')
    await this.source.requireAvailable(id)
    signal.throwIfAborted()
    return agent
  }

  async list(id: SessionId, params: Record<string, unknown>, signal: AbortSignal) {
    const registry = this.registry()
    if (params.query !== undefined && params.query !== null && typeof params.query !== 'string') throw new BridgeError('INVALID_PARAMS', 'The command query must be a string.')
    const limit = params.limit ?? 50
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new BridgeError('INVALID_PARAMS', 'The command limit must be an integer between 1 and 1000.')
    const query = typeof params.query === 'string' ? params.query.toLocaleLowerCase() : ''
    const agent = await this.agent(id, signal)
    return { commands: registry.list(agent)
      .filter(item => item.name === 'compact')
      .filter(item => `${item.name} ${item.description} ${item.input?.hint ?? ''}`.toLocaleLowerCase().includes(query))
      .slice(0, limit).map(item => ({
        id: item.name, title: item.name, description: item.description, aliases: [], scope: 'session', enabled: true,
        acceptsArgs: item.input !== undefined,
        ...(item.input ? { argsSchema: { type: 'string', description: item.input.hint } } : {}),
        metadata: {
          ...(item.definitionId ? { definitionId: item.definitionId } : {}),
          ...(item.input ? { input: item.input } : {}), attachmentsAvailable: false,
          ui: { kind: 'execute', ...(item.input ? { argumentHint: item.input.hint } : {}),
            acceptsMultiline: true, allowedStatuses: [...ONLINE_STATUSES] },
        },
      })) }
  }

  async execute(id: SessionId, params: Record<string, unknown>, signal: AbortSignal): Promise<CommandResult> {
    const registry = this.registry()
    const command = typeof params.command === 'string' ? params.command : ''
    const fail = (code: string, message: string): CommandResult => ({ command, ok: false, code, message, result: {} })
    if (!command || parseCommand(`/${command}`)?.name !== command) return fail('invalid_command', 'Use the native command name from the catalog.')
    if (command !== 'compact') return fail('unknown_command', 'AA supports only /compact for DSH.')
    const args = params.args === undefined ? [] : params.args
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return fail('invalid_command', 'Command arguments must be strings.')
    if (params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.length)) return fail('command_attachments_unsupported', 'AA command attachments are unavailable. Keep attachments in the draft.')
    let line: string
    if (params.raw !== undefined && params.raw !== null) {
      if (typeof params.raw !== 'string') return fail('invalid_command', 'The raw command must be a string.')
      line = params.raw
    } else {
      if (args.length > 1) return fail('invalid_command', 'Provide exact raw input for multiple command arguments.')
      line = `/${command}${args.length ? ` ${args[0]}` : ''}`
    }
    const parsed = parseCommand(line)
    if (!parsed || parsed.name !== command) return fail('invalid_command', 'The raw command must invoke the requested native command name.')
    const agent = await this.agent(id, signal)
    // Cancellation before admission is a known rejection. Once the native handler
    // starts, thrown/aborted execution cannot prove its effects were rolled back.
    signal.throwIfAborted()
    try {
      const execution = await registry.execute(agent, line, [], signal)
      if (!execution) return fail('unknown_command', 'This native DSH command is not registered for this Agent. Refresh the command menu.')
      const result = execution.result
      return { command, ok: result.kind === 'success',
        ...(result.kind === 'error' ? { code: 'command_error' } : {}),
        ...(result.text !== undefined ? { message: result.text } : {}),
        result: { commandId: execution.commandId, kind: result.kind,
          ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.kind === 'success' && result.sourceEventSeq !== undefined ? { sourceEventSeq: Number(result.sourceEventSeq) } : {}),
          executionState: result.kind === 'success' ? 'accepted' : 'completed' },
      }
    } catch {
      return { command, ok: false, code: signal.aborted ? 'command_outcome_unknown' : 'command_failed',
        message: 'DSH command execution could not be confirmed. Refresh session state before deciding whether to submit again.',
        result: { executionState: 'unknown', retryable: false } }
    }
  }
}
