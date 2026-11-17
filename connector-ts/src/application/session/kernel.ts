import type { Session, TimelineDraft } from '../../domain/conversation/index.js'
import { UseCaseError } from '../errors.js'
import type { ChangeFeed, Clock, ConversationStore, IdSource, LiveEvents, PromptAttachment, RuntimeHandles, SessionCommit } from '../ports/index.js'

export interface ConversationDeps {
  readonly store: ConversationStore
  readonly feed: ChangeFeed
  readonly live: LiveEvents
  readonly runtimes: RuntimeHandles
  readonly clock: Clock
  readonly ids: IdSource
  /** Streaming commit window per item. */
  readonly coalesceMs?: number
  /** Resolves a Server file id to a local path once the attachment is downloaded (workspace). */
  readonly attachments?: (sessionId: string, ref: AttachmentRef) => Promise<PromptAttachment>
  /** Projects the latest page of an existing native session before it is opened (04-connector.md §6.6). */
  readonly history?: { ensureLatest(sessionId: string): Promise<void> }
}

export interface AttachmentRef {
  fileId: string
  name: string
  mediaType: string
  size: number
  sha256?: string | null
  /** E2EE: the key of a sealed upload (contracts/e2ee/1.0 `SealedAttachmentKey`); the bytes on the Server are ciphertext. */
  sealedKey?: string | null
}

export type SessionChange = {
  upserts: TimelineDraft[]
  replace?: { range?: { afterOrderSeq: number | null; throughOrderSeq: number | null } }
  session?: Parameters<ConversationStore['sessions']['update']>[1]
}

/**
 * What every session use case shares: per-session serialization, the commit that publishes on the ChangeFeed,
 * lossy session facts on `runtime.status`, and the background error log. Single writer per device.
 */
export class SessionKernel {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly errors: { sessionId: string; error: unknown }[] = []

  public constructor(public readonly deps: ConversationDeps) {}

  /** Errors swallowed by background work (event loops, dispatch); exposed for logs and tests. */
  public get backgroundErrors(): readonly { sessionId: string; error: unknown }[] {
    return this.errors
  }

  public reportError(sessionId: string, error: unknown): void {
    this.errors.push({ sessionId, error })
    if (this.errors.length > 100) this.errors.shift()
  }

  /** Runs `work` after every earlier piece of work for the same session. */
  public serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.catch(() => undefined)
    this.chains.set(sessionId, tail)
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId)
    })
    return next
  }

  /** Commits a timeline change and publishes it on the ChangeFeed. */
  public async commit(sessionId: string, change: SessionChange): Promise<SessionCommit> {
    const commit = await this.deps.store.timeline.apply(sessionId, { ...change, at: this.deps.clock.nowIso() })
    this.publish(commit)
    return commit
  }

  public async patchSession(sessionId: string, patch: Parameters<ConversationStore['sessions']['update']>[1]): Promise<SessionCommit> {
    const commit = await this.deps.store.sessions.update(sessionId, patch)
    this.publish(commit)
    return commit
  }

  /** Tells ChangeFeed subscribers about a commit, and the Server about a changed session status. */
  public publish(commit: SessionCommit): void {
    if (commit.toSeq >= commit.fromSeq && (commit.changed.length > 0 || commit.deleted.length > 0 || commit.reset)) {
      this.deps.feed.publish({
        sessionId: commit.session.sessionId,
        fromSeq: commit.fromSeq,
        toSeq: commit.toSeq,
        resetSeq: commit.session.clock.resetSeq,
        reset: commit.reset,
      })
    }
    if (commit.summary !== null) this.deps.live.emit('runtime.status', { runtimeId: commit.session.runtimeId, sessionId: commit.session.sessionId, status: { event: 'session.status', status: commit.session.status } })
  }

  /**
   * A session fact on `Link/attach` as `runtime.status` (device-meshcall 1.0 requires `runtimeId`):
   * `{runtimeId, sessionId, status: {event: <v2 event name>, ...}}`. Lossy, so a failed lookup drops it.
   */
  public emitSessionStatus(sessionId: string, status: Record<string, unknown>): void {
    void this.deps.store.sessions.get(sessionId).then(session => {
      if (session !== null) this.deps.live.emit('runtime.status', { runtimeId: session.runtimeId, sessionId, status })
    }, () => undefined)
  }

  public async requireSession(sessionId: string): Promise<Session> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) throw new UseCaseError('session_not_found', `session ${sessionId} is not on this device`)
    return session
  }
}
