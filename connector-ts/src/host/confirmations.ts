// The person at this computer confirming a trust change (docs/v3/11-e2ee-noise.md §7.2): a client approved by an
// already paired client is only written once someone here said yes. The host answers either on its own terminal
// (the CLI) or through `aa.local.v2.Control/confirmations` (Desktop shows a dialog). No answer is a no.
import { randomBytes } from 'node:crypto'

/** What the device asks: who approves whom, and the fingerprint to compare with the new client's screen. */
export interface ClientApprovalRequest {
  readonly approverLabel: string
  readonly label: string
  readonly fingerprint: string
}

export interface PendingConfirmation extends ClientApprovalRequest {
  readonly confirmationId: string
  readonly kind: 'client_approval'
  readonly expiresAt: string
}

export type ConfirmationEvent =
  | { readonly kind: 'requested'; readonly confirmation: PendingConfirmation }
  | { readonly kind: 'settled'; readonly confirmationId: string; readonly approved: boolean }

/** Asks on this process's own terminal; resolves false (or rejects) when the answer is not a yes or `signal` aborts. */
export type TerminalConfirmer = (request: PendingConfirmation, signal: AbortSignal) => Promise<boolean>

/** How long a request waits for the person at this computer before it counts as refused. */
export const CONFIRMATION_TIMEOUT_MS = 120_000

export interface LocalConfirmationsOptions {
  readonly timeoutMs?: number
  readonly now?: () => number
}

interface Pending {
  readonly confirmation: PendingConfirmation
  readonly settle: (approved: boolean) => void
}

/**
 * The `LocalConfirmation` port of Device Trust for one host process. A request goes to the terminal confirmer when
 * the host has one, and to every `follow` subscriber (Desktop); the first answer wins. With nobody to ask it is
 * refused at once; a timeout, an aborted prompt or anything but an explicit yes is a refusal too.
 */
export class LocalConfirmations {
  private terminal: TerminalConfirmer | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly watchers = new Set<(event: ConfirmationEvent) => void>()

  public constructor(private readonly options: LocalConfirmationsOptions = {}) {}

  /** Answers on this process's terminal from now on (the CLI host); returns the undo. */
  public useTerminal(confirmer: TerminalConfirmer): () => void {
    this.terminal = confirmer
    return () => {
      if (this.terminal === confirmer) this.terminal = null
    }
  }

  /** Whether anyone could answer right now (a terminal, or a host following the confirmations). */
  public get answerable(): boolean {
    return this.terminal !== null || this.watchers.size > 0
  }

  public async confirmClientApproval(request: ClientApprovalRequest): Promise<boolean> {
    if (!this.answerable) return false
    const timeoutMs = this.options.timeoutMs ?? CONFIRMATION_TIMEOUT_MS
    const now = this.options.now?.() ?? Date.now()
    const confirmation: PendingConfirmation = {
      confirmationId: `conf_${randomBytes(12).toString('base64url')}`,
      kind: 'client_approval',
      approverLabel: request.approverLabel,
      label: request.label,
      fingerprint: request.fingerprint,
      expiresAt: new Date(now + timeoutMs).toISOString(),
    }
    const abort = new AbortController()
    let settle!: (approved: boolean) => void
    const answered = new Promise<boolean>(resolve => {
      settle = resolve
    })
    let done = false
    const finish = (approved: boolean): void => {
      if (done) return
      done = true
      settle(approved)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    this.pending.set(confirmation.confirmationId, { confirmation, settle: finish })
    this.publish({ kind: 'requested', confirmation })
    const terminal = this.terminal
    if (terminal !== null) {
      terminal(confirmation, abort.signal).then(approved => finish(approved === true), () => finish(false))
    }
    try {
      return (await answered) === true
    } finally {
      clearTimeout(timer)
      abort.abort()
      this.pending.delete(confirmation.confirmationId)
      this.publish({ kind: 'settled', confirmationId: confirmation.confirmationId, approved: await answered })
    }
  }

  /** A host's answer; false when the request is unknown or already settled (timed out, answered elsewhere). */
  public answer(confirmationId: string, approved: boolean): boolean {
    const pending = this.pending.get(confirmationId)
    if (pending === undefined) return false
    pending.settle(approved === true)
    return true
  }

  /** Requests still waiting, then every request and settlement until `signal` aborts. */
  public async *follow(signal: AbortSignal): AsyncGenerator<ConfirmationEvent> {
    const queue: ConfirmationEvent[] = [...this.pending.values()].map(pending => ({ kind: 'requested', confirmation: pending.confirmation }) as const)
    let wake: (() => void) | null = null
    const watcher = (event: ConfirmationEvent): void => {
      queue.push(event)
      wake?.()
    }
    const onAbort = (): void => wake?.()
    this.watchers.add(watcher)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>(resolve => {
          wake = resolve
        })
        wake = null
      }
    } finally {
      this.watchers.delete(watcher)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private publish(event: ConfirmationEvent): void {
    for (const watcher of this.watchers) watcher(event)
  }
}
