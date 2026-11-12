import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { BridgeError } from './errors.js'
import type { RuntimeConfiguration } from './configuration.js'
import type { NativeRuntime } from './native.js'
import type { NativeSessionSource } from './sessions/source.js'

/** Structural view of dsh-api-session-controller's SessionSkillCatalog remote service. */
interface SkillCatalogService {
  list(request: { sessionId: string }, signal?: AbortSignal): Promise<{
    skills: Array<{ name: string, description: string, modelInvocable: boolean }>
  }>
}

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

/**
 * AA exposes the native compact command, the native /plan command when the DSH
 * plan-mode service is composed, a model-selector entry backed by AA's own
 * model catalog, and the session's user-invocable DSH skills; the registry owns
 * their grammar and side effects.
 */
export class RuntimeCommands {
  private readonly instance = randomUUID()
  private revision = 0
  private readonly unwatch: () => void

  constructor(private ctx: Context, private configuration: RuntimeConfiguration,
    private source: NativeSessionSource, private native: () => NativeRuntime, private changed: () => void) {
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

  /**
   * Session-scoped user-invocable skills. The catalog is re-read on every list
   * call (each command-menu open), so installs land on the next open without a
   * dedicated change event; a missing or failing service degrades to no skills.
   */
  private async skills(id: SessionId, signal: AbortSignal) {
    const catalog = this.ctx.get('sessionSkillCatalog') as SkillCatalogService | undefined
    if (!catalog) return []
    try { return (await catalog.list({ sessionId: id }, signal)).skills }
    catch (error) {
      this.ctx.logger.warn('AA skill catalog unavailable; the command menu skips skills.', error)
      return []
    }
  }

  /** /plan is a native DSH command; it is offered only when the plan-mode service is composed. */
  private planModeAvailable(): boolean {
    return Boolean((this.ctx as unknown as { get(key: string): unknown }).get('planMode'))
  }

  /** The /model entry rides on AA's own model selector; it needs a routable provider catalog. */
  private async modelSelectorAvailable(): Promise<boolean> {
    const native = this.native()
    if (!native.configuration.canSelectModel) return false
    try { return (await native.catalogs.models()).metadata.routableProviders.length > 0 }
    catch { return false }
  }

  async list(id: SessionId, params: Record<string, unknown>, signal: AbortSignal) {
    const registry = this.registry()
    if (params.query !== undefined && params.query !== null && typeof params.query !== 'string') throw new BridgeError('INVALID_PARAMS', 'The command query must be a string.')
    const limit = params.limit ?? 50
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new BridgeError('INVALID_PARAMS', 'The command limit must be an integer between 1 and 1000.')
    const query = typeof params.query === 'string' ? params.query.toLocaleLowerCase() : ''
    const agent = await this.agent(id, signal)
    const entries: Array<{ id: string, search: string, entry: Record<string, unknown> }> = registry.list(agent)
      .filter(item => item.name === 'compact' || (item.name === 'plan' && this.planModeAvailable()))
      .map(item => ({
        id: item.name,
        search: `${item.name} ${item.description} ${item.input?.hint ?? ''}`.toLocaleLowerCase(),
        entry: {
          id: item.name, title: item.name, description: item.description, aliases: [], scope: 'session', enabled: true,
          acceptsArgs: item.input !== undefined,
          ...(item.input ? { argsSchema: { type: 'string', description: item.input.hint } } : {}),
          metadata: {
            ...(item.definitionId ? { definitionId: item.definitionId } : {}),
            ...(item.input ? { input: item.input } : {}), attachmentsAvailable: false,
            ui: { kind: 'execute', ...(item.input ? { argumentHint: item.input.hint } : {}),
              acceptsMultiline: true, allowedStatuses: [...ONLINE_STATUSES] },
          },
        },
      }))
    if (await this.modelSelectorAvailable()) entries.push({ id: 'model', search: 'model', entry: {
      id: 'model', title: 'model', description: 'Switch the model for this session.', aliases: [], scope: 'session',
      enabled: true, acceptsArgs: false, metadata: { ui: { kind: 'selector', target: 'model' } },
    } })
    for (const skill of await this.skills(id, signal)) {
      // A skill named like a native entry stays shadowed; the native entry owns the id.
      if (entries.some(entry => entry.id === skill.name)) continue
      entries.push({ id: skill.name, search: `${skill.name} ${skill.description}`.toLocaleLowerCase(), entry: {
        id: skill.name, title: skill.name, description: skill.description, aliases: [], scope: 'session', enabled: true,
        acceptsArgs: true, argsSchema: { type: 'string', description: 'Arguments appended after the skill name.' },
        metadata: { attachmentsAvailable: false,
          ui: { kind: 'execute', argumentHint: 'Arguments appended after the skill name.',
            acceptsMultiline: true, allowedStatuses: [...ONLINE_STATUSES] } },
      } })
    }
    return { commands: entries.filter(entry => entry.search.includes(query)).slice(0, limit).map(entry => entry.entry) }
  }

  async execute(id: SessionId, params: Record<string, unknown>, signal: AbortSignal): Promise<CommandResult> {
    const registry = this.registry()
    const command = typeof params.command === 'string' ? params.command : ''
    const fail = (code: string, message: string): CommandResult => ({ command, ok: false, code, message, result: {} })
    if (!command || parseCommand(`/${command}`)?.name !== command) return fail('invalid_command', 'Use the native command name from the catalog.')
    if (command === 'model') return fail('unknown_command', '/model opens the model selector; choose it from the command menu.')
    if (command === 'plan' && !this.planModeAvailable()) return fail('unknown_command', 'This DSH command is not available in AA.')
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
    if (command !== 'compact' && command !== 'plan') return await this.executeSkill(id, command, line, signal)
    const agent = await this.agent(id, signal)
    // Settlement races a short budget: quick commands keep their full settled
    // result; slow ones (/compact on a large session outlives every RPC
    // timeout up the chain — server 30s, bridge client 30s) report accepted
    // instead of surfacing a false "outcome unknown" after a timed-out wait.
    // The registry signal follows the request signal while the caller waits,
    // so an in-flight cancel still aborts and settles the native handler; on
    // the timeout win the follower is detached and late settlement lands on
    // the session log (command/done).
    signal.throwIfAborted()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<'timed-out'>(resolve => { timer = setTimeout(() => resolve('timed-out'), 5000) })
    try {
      const winner = await Promise.race([
        registry.execute(agent, line, [], controller.signal).then(value => value ?? ('unregistered' as const)),
        budget,
      ])
      if (winner === 'timed-out') {
        // Contract: an ok ack must carry kind='success' + commandId; the
        // connector validates all three or downgrades to "outcome unknown".
        // No native commandId exists yet at budget expiry, so a stable
        // synthetic one stands in (server and clients never join on it).
        return { command, ok: true, result: { commandId: `pending-${randomUUID()}`, kind: 'success', executionState: 'accepted' } }
      }
      if (winner === 'unregistered') return fail('unknown_command', 'This native DSH command is not registered for this Agent. Refresh the command menu.')
      const execution = winner
      const result = execution.result
      return { command, ok: result.kind === 'success',
        ...(result.kind === 'error' ? { code: 'command_error' } : {}),
        ...(result.text !== undefined ? { message: result.text } : {}),
        result: { commandId: execution.commandId, kind: result.kind,
          ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.kind === 'success' && result.sourceEventSeq !== undefined ? { sourceEventSeq: Number(result.sourceEventSeq) } : {}),
          executionState: result.kind === 'success' ? 'accepted' : 'completed' },
      }
    } catch (error) {
      // 秒报"结果不确定"多为此处瞬间抛错（宿主命令服务不兼容等），
      // 静默会把真实原因藏成不可归因的 uncertain——必须留痕。
      this.ctx.logger.warn('DSH command execution could not be confirmed', error)
      return { command, ok: false, code: signal.aborted ? 'command_outcome_unknown' : 'command_failed',
        message: 'DSH command execution could not be confirmed. Refresh session state before deciding whether to submit again.',
        result: { executionState: 'unknown', retryable: false } }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (!signal.aborted) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * A skill runs exactly the way it does in DSH's own composer: the `/name …`
   * line goes out as one queued user message and the host's agent pre-step
   * injects the skill body when it sees the `/name` token. Revalidated against
   * the live catalog so stale menu entries cannot smuggle unknown text through
   * the command admission path.
   */
  private async executeSkill(id: SessionId, command: string, line: string, signal: AbortSignal): Promise<CommandResult> {
    const fail = (code: string, message: string): CommandResult => ({ command, ok: false, code, message, result: {} })
    const skills = await this.skills(id, signal)
    if (!skills.some(skill => skill.name === command)) return fail('unknown_command', 'AA supports /compact, the model selector and user-invocable DSH skills.')
    signal.throwIfAborted()
    try {
      await this.native().send(id, line, randomUUID(), undefined, false, {}, undefined, signal)
      // Same contract as the compact timeout branch: ok acks need the full trio.
      return { command, ok: true, result: { commandId: `pending-${randomUUID()}`, kind: 'success', executionState: 'accepted' } }
    } catch (error) {
      // 静默吞错让每个失败都变成不可归因的"结果不确定"——记日志留痕。
      this.ctx.logger.warn('DSH skill execution could not be confirmed', error)
      return { command, ok: false, code: signal.aborted ? 'command_outcome_unknown' : 'command_failed',
        message: 'DSH skill execution could not be confirmed. Check the timeline before submitting again.',
        result: { executionState: 'unknown', retryable: false } }
    }
  }
}
