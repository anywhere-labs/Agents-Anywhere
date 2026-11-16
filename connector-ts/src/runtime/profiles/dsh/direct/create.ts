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
import type { DshDirectRoute } from './route.js'
import type { DshDirectSession } from './session.js'

const MAX_LIST_PAGES = 10

async function listCwd(route: DshDirectRoute, cwd: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await route.conn.listSessions({ cwd, ...(cursor ? { cursor } : {}) })
    for (const session of result.sessions) if (session.cwd === cwd) ids.push(session.sessionId)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return ids
}

export type CreationOutcome = { session: DshDirectSession, adopted: boolean }

export async function createDirectSession(route: DshDirectRoute, ids: DshSessionIds,
  spec: { platformSessionId: string, cwd: string }, now: () => number = Date.now): Promise<CreationOutcome> {
  const store = ids.store
  const bound = await store.byPlatform(spec.platformSessionId)
  if (bound) return { session: await route.open({ externalSessionId: bound.dshSessionId, cwd: bound.cwd }), adopted: true }

  const pending = await store.intent(spec.platformSessionId)
  if (pending) {
    const known = new Set(pending.knownBefore)
    const candidates: string[] = []
    for (const id of await listCwd(route, pending.cwd)) {
      if (!known.has(id) && !(await store.byDsh(id))) candidates.push(id)
    }
    // Exactly one new session in that cwd is ours; anything else is ambiguous and we start over.
    if (candidates.length === 1) {
      const dshSessionId = candidates[0]!
      await ids.remember({ platformSessionId: spec.platformSessionId, dshSessionId, route: 'direct', cwd: pending.cwd, createdAt: pending.startedAt })
      await store.deleteIntent(spec.platformSessionId)
      return { session: await route.open({ externalSessionId: dshSessionId, cwd: pending.cwd }), adopted: true }
    }
  }

  await store.putIntent({ platformSessionId: spec.platformSessionId, cwd: spec.cwd, startedAt: now(), knownBefore: await listCwd(route, spec.cwd) })
  const session = await route.open({ cwd: spec.cwd })
  await ids.remember({ platformSessionId: spec.platformSessionId, dshSessionId: session.externalSessionId, route: 'direct', cwd: spec.cwd, createdAt: now() })
  await store.deleteIntent(spec.platformSessionId)
  return { session, adopted: false }
}
