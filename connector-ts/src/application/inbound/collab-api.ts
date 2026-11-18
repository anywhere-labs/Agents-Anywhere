import type { ChannelCaller } from './tunnel-api.js'

/**
 * The client API of agent collaboration on the supervisor's device (`GET /sessions/{id}/collab`, `POST
 * .../collab/supervisions`, `PATCH .../collab/supervisions/{sid}`): people see and manage what a supervisor session
 * does. Implemented by the collaboration use cases; the client API adapter maps the routes onto it.
 */
export interface CollabClientApi {
  view(sessionId: string): Promise<Record<string, unknown>>
  supervise(caller: ChannelCaller, supervisorSessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
  updateSupervision(caller: ChannelCaller, supervisorSessionId: string, supervisionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
}
