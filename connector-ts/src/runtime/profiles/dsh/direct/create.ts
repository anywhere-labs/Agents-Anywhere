/**
 * Creating a direct-route session without ever creating two (DSH-2).
 *
 * DSH's `session/new` persists an empty session and returns a random UUID. If that answer
 * is lost (DSH crashed, the Connector restarted mid-call), a blind retry would leave AA
 * pointing at a second session. So the creation intent, with the IDs DSH already listed
 * for the cwd, is stored before the call; a retry first looks for exactly one new,
 * unaliased session in that cwd and adopts it.
 */
import type { DshSessionIds } from '../session-ids.js'

export interface DirectCreationOps<S extends { readonly nativeSessionId: string }> {
  /** DSH session IDs `session/list` reports for exactly this cwd. */
  list(cwd: string): Promise<string[]>
  /** Attach an existing DSH session (`session/resume`). */
  attach(nativeSessionId: string, cwd: string): Promise<S>
  /** `session/new` in this cwd. */
  create(cwd: string): Promise<S>
}

export type CreationOutcome<S> = { session: S, adopted: boolean }

export async function createDirectSession<S extends { readonly nativeSessionId: string }>(ops: DirectCreationOps<S>, ids: DshSessionIds,
  spec: { platformSessionId: string, cwd: string }, now: () => number = Date.now): Promise<CreationOutcome<S>> {
  const store = ids.store
  const bound = await store.byPlatform(spec.platformSessionId)
  if (bound) return { session: await ops.attach(bound.dshSessionId, bound.cwd), adopted: true }

  const pending = await store.intent(spec.platformSessionId)
  if (pending) {
    const known = new Set(pending.knownBefore)
    const candidates: string[] = []
    for (const id of await ops.list(pending.cwd)) {
      if (!known.has(id) && !(await store.byDsh(id))) candidates.push(id)
    }
    // Exactly one new session in that cwd is ours; anything else is ambiguous and we start over.
    if (candidates.length === 1) {
      const dshSessionId = candidates[0]!
      await ids.remember({ platformSessionId: spec.platformSessionId, dshSessionId, route: 'direct', cwd: pending.cwd, createdAt: pending.startedAt })
      await store.deleteIntent(spec.platformSessionId)
      return { session: await ops.attach(dshSessionId, pending.cwd), adopted: true }
    }
  }

  await store.putIntent({ platformSessionId: spec.platformSessionId, cwd: spec.cwd, startedAt: now(), knownBefore: await ops.list(spec.cwd) })
  const session = await ops.create(spec.cwd)
  await ids.remember({ platformSessionId: spec.platformSessionId, dshSessionId: session.nativeSessionId, route: 'direct', cwd: spec.cwd, createdAt: now() })
  await store.deleteIntent(spec.platformSessionId)
  return { session, adopted: false }
}
