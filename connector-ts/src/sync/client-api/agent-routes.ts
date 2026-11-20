// The client API routes an Agent caller may use on this device (agent collaboration), the device-side counterpart of
// the Server's `ClientRoute.agent` flags: the Server checks a delegated caller in normal mode; this check covers the
// in-process collaboration tools and `agent` channel clients, which the Server does not see.

const SESSION_ROUTES = new Set([
  'GET meta', 'GET timeline', 'GET runtime/notices',
  'POST runtime/messages', 'POST runtime/steer', 'POST runtime/interrupt',
])

export function agentRouteAllowed(method: string, segments: readonly string[]): boolean {
  const [area, id, ...rest] = segments
  if (area === 'sessions' && id === 'create-and-start' && rest.length === 0) return method === 'POST'
  if (area === 'runtime-workflows' && id === 'sessions' && rest.length === 2 && rest[1] === 'close') return method === 'POST'
  return area === 'sessions' && id !== undefined && SESSION_ROUTES.has(`${method} ${rest.join('/')}`)
}
