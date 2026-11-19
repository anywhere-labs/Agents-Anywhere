// The client API routes an Agent caller may use on this device (agent collaboration), the device-side counterpart of
// the Server's `ClientRoute.agent` flags: the Server checks a delegated caller in normal mode; this check covers the
// in-process collaboration tools and `agent` channel clients, which the Server does not see.

const SESSION_ROUTES: ReadonlySet<string> = new Set([
  'GET snapshot',
  'GET meta',
  'GET timeline',
  'GET events',
  'GET runtime/state',
  'GET runtime/capabilities',
  'GET runtime/notices',
  'GET runtime/queue',
  'GET planning',
  'GET goal',
  'GET plans',
  'GET collab',
  'POST runtime/messages',
  'POST runtime/steer',
  'POST runtime/interrupt',
  'POST planning',
])

/** Whether an Agent caller may call `method` on `segments` (the path under `/api/v2`, split). */
export function agentRouteAllowed(method: string, segments: readonly string[]): boolean {
  const [area, id, ...rest] = segments
  if (area === 'connectors' && id !== undefined && rest.length === 2 && rest[0] === 'a2a') {
    return method === 'GET' && rest[1] === 'agent-card.json' || method === 'POST' && rest[1] === 'review'
  }
  if (area === 'sessions' && id === 'create-and-start' && rest.length === 0) return method === 'POST'
  // Releasing a session's Agent session (`aa_close`).
  if (area === 'runtime-workflows' && id === 'sessions' && rest.length === 2 && rest[1] === 'close') return method === 'POST'
  if (area !== 'sessions' || id === undefined) return false
  const path = `${method} ${rest.join('/')}`
  if (SESSION_ROUTES.has(path)) return true
  if (method === 'GET' && rest[0] === 'plans' && (rest.length === 3 || (rest.length === 4 && rest[3] === 'markdown'))) return true
  return method === 'POST' && rest[0] === 'runtime' && rest[1] === 'notices' && rest[3] === 'respond' && rest.length === 4
}
