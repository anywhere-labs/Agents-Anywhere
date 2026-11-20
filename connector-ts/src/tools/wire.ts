// The line protocol between the injected `aa` tool server and the Connector's agent-tools socket: one JSON object
// per line each way. The tool server is a thin relay; the Connector checks the grant and runs the tool.

export interface ToolCallLine {
  readonly id: number
  readonly token: string
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

export type ToolReplyLine =
  | { readonly id: number; readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly id: number; readonly ok: false; readonly code: string; readonly message: string }

/** A request line is capped so a broken client cannot make the Connector buffer without bound. */
export const MAX_LINE_BYTES = 1024 * 1024

export const ENDPOINT_ENV = 'AA_AGENT_TOOLS_ENDPOINT'
export const TOKEN_ENV = 'AA_AGENT_TOOLS_TOKEN'
