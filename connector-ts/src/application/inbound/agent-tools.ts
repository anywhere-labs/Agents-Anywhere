/**
 * The collaboration tool calls the local tool socket forwards (contracts/agent-tools/1.0): `secret` is the tool
 * server's grant secret, `tool` one of the tools, `args` its arguments. Implemented by the collaboration use cases.
 */
export interface AgentToolCalls {
  call(secret: string, tool: string, args: Record<string, unknown>): Promise<AgentToolOutcome>
}

export type AgentToolOutcome =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string }
