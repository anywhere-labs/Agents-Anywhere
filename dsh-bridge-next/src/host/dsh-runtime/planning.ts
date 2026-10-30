import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RuntimeConfiguration } from './configuration.js'
import { BridgeError } from './errors.js'

// Structural boundary deliberately allows older DSH compositions to report absence.
interface PlanService {
  get(agent: Agent): { active: boolean, pending?: boolean }
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}
export class RuntimePlanning {
  constructor(private ctx: Context, private configuration: RuntimeConfiguration) {}
  service(): PlanService | undefined {
    const value = (this.ctx as unknown as { get(key: string): unknown }).get('planMode') as Partial<PlanService> | undefined
    return value && typeof value.get === 'function' && typeof value.set === 'function' ? value as PlanService : undefined
  }
  async read(id: SessionId) {
    const service = this.service()
    if (!service) return { available: false }
    return { available: true, ...service.get(await this.configuration.agent(id)) }
  }
  async set(id: SessionId, active: boolean) {
    const service = this.service()
    if (!service) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH Plan service is not composed; enable the native plan-mode plugin.')
    const agent = await this.configuration.agent(id)
    const outcome = service.set(agent, active)
    await this.ctx.sessions.flush(agent.session)
    return { outcome, ...service.get(agent) }
  }
}
