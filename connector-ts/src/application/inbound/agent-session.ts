/** Reads of a session's Agent session that the client API serves (`ConversationService` implements them). */
export interface AgentSessionReads {
  /** `GET runtime-workflows/sessions/{id}/configuration`. */
  agentConfiguration(sessionId: string): Promise<Record<string, unknown>>
  /** `GET runtime-workflows/sessions/{id}/tree`. */
  agentTree(sessionId: string, values: { readonly [key: string]: string | number }): Promise<Record<string, unknown>>
}
