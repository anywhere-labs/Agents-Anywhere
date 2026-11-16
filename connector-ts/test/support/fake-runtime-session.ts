// 测试替身：一个可编排的 RuntimeSession，供会话引擎（A）与 DSH（E）的测试使用。
// emit() 推事件；calls 记录所有调用；nextPrompt / nextSteer 决定下一次调用的结果。

import type {
  CommandResult,
  ConfigChange,
  ConfigResult,
  DeliveryRef,
  InteractionAnswer,
  PromptAcceptance,
  PromptInput,
  RuntimeEvent,
  RuntimeSession,
  SessionCapabilities,
  SteerResult,
} from '../../src/application/ports/runtime-session.js'

export class PushQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.buffer.push(value)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffer.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }
}

export type FakeCall =
  | { method: 'prompt'; input: PromptInput; delivery: DeliveryRef }
  | { method: 'steer'; input: PromptInput; delivery: DeliveryRef }
  | { method: 'cancel'; expectedTurnId: string | undefined }
  | { method: 'respond'; interactionId: string; answer: InteractionAnswer }
  | { method: 'configure'; change: ConfigChange }
  | { method: 'command'; name: string; args: string | undefined }
  | { method: 'close' }

export class FakeRuntimeSession implements RuntimeSession {
  readonly calls: FakeCall[] = []
  readonly events: PushQueue<RuntimeEvent> = new PushQueue()
  nextPrompt: PromptAcceptance = { outcome: 'accepted' }
  nextSteer: SteerResult = { outcome: 'injected' }
  capabilities: SessionCapabilities

  constructor(
    readonly sessionId: string,
    readonly nativeSessionId: string,
    capabilities: SessionCapabilities = { revision: 1, items: [{ id: 'session.send_message', supported: true }] },
  ) {
    this.capabilities = capabilities
  }

  emit(event: RuntimeEvent): void {
    this.events.push(event)
  }

  async prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance> {
    this.calls.push({ method: 'prompt', input, delivery })
    return this.nextPrompt
  }

  async steer(input: PromptInput, delivery: DeliveryRef): Promise<SteerResult> {
    this.calls.push({ method: 'steer', input, delivery })
    return this.nextSteer
  }

  async cancel(expectedTurnId?: string): Promise<void> {
    this.calls.push({ method: 'cancel', expectedTurnId })
  }

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void> {
    this.calls.push({ method: 'respond', interactionId, answer })
  }

  async configure(change: ConfigChange): Promise<ConfigResult> {
    this.calls.push({ method: 'configure', change })
    return { options: [], appliesFrom: 'now' }
  }

  async command(name: string, args?: string): Promise<CommandResult> {
    this.calls.push({ method: 'command', name, args })
    return { ok: true }
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close' })
    this.events.close()
  }
}
