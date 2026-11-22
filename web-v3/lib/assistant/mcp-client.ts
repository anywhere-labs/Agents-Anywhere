// Multi-server Streamable HTTP MCP client for Portable Assistant (Pi Lite).
// Supports:
//   - Built-in one-click mount of AA's own `/mcp` (cross-device orchestration over normal allow_mcp devices)
//   - Arbitrary external Streamable HTTP MCP servers
//   - Unified high-risk / write tool classification for `beforeToolCall` confirmation

import type { AssistantMcpServerConfig } from "@/lib/storage/idb"

export interface McpToolSpec {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  /** MCP tool annotations; only `readOnlyHint` is used here (to skip confirmation). */
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown }
}

export interface McpToolCallResult {
  content: { type: string; text?: string }[]
  isError?: boolean
}

export class McpClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpClientError"
  }
}

// Streamable HTTP MCP: `initialize` + `notifications/initialized` first, then every request carries the
// `Mcp-Session-Id` the server handed out (if any). Stateless servers (AA's own `/mcp`) simply return none.
const MCP_PROTOCOL_VERSION = "2025-06-18"

interface McpSession {
  sessionId: string | null
  protocolVersion: string
}

const sessions = new Map<string, Promise<McpSession>>()
let rpcSeq = 1

function sessionKey(server: Pick<AssistantMcpServerConfig, "url" | "token">): string {
  return `${server.url}\n${server.token ?? ""}`
}

function parseRpcBody<T>(text: string): { result?: T; error?: { message?: string } } | null {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as { result?: T; error?: { message?: string } }
    } catch {
      return null
    }
  }
  if (text.includes("data:")) {
    // Some Streamable HTTP MCP servers wrap a single JSON-RPC reply in an SSE frame.
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as { id?: unknown; result?: T; error?: { message?: string } }
        if ("result" in parsed || "error" in parsed) return parsed
      } catch {
        // keep looking
      }
    }
  }
  return null
}

function baseHeaders(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  session: McpSession | null
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  if (server.token) headers.Authorization = `Bearer ${server.token}`
  if (session) {
    headers["MCP-Protocol-Version"] = session.protocolVersion
    if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId
  }
  return headers
}

async function postRpc<T>(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  session: McpSession | null,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ result: T; response: Response }> {
  const res = await fetch(server.url, {
    method: "POST",
    signal,
    headers: baseHeaders(server, session),
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method, params }),
  })
  const parsed = parseRpcBody<T>(await res.text())
  if (!res.ok) {
    const err = new McpClientError(parsed?.error?.message ?? `MCP request failed (${res.status})`)
    ;(err as McpClientError & { status?: number }).status = res.status
    throw err
  }
  if (parsed?.error) throw new McpClientError(parsed.error.message ?? "MCP error")
  if (!parsed || parsed.result === undefined) {
    throw new McpClientError("MCP server returned an empty or unreadable response")
  }
  return { result: parsed.result, response: res }
}

async function openSession(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  signal?: AbortSignal
): Promise<McpSession> {
  const { result, response } = await postRpc<{ protocolVersion?: string }>(
    server,
    null,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agents-anywhere-web", version: "3.0.0" },
    },
    signal
  )
  const session: McpSession = {
    sessionId: response.headers.get("mcp-session-id"),
    protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION,
  }
  // A notification: no id, no JSON-RPC reply (servers answer 202).
  await fetch(server.url, {
    method: "POST",
    signal,
    headers: baseHeaders(server, session),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => undefined)
  return session
}

function getSession(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  signal?: AbortSignal
): Promise<McpSession> {
  const key = sessionKey(server)
  let pending = sessions.get(key)
  if (!pending) {
    pending = openSession(server, signal)
    sessions.set(key, pending)
    pending.catch(() => {
      if (sessions.get(key) === pending) sessions.delete(key)
    })
  }
  return pending
}

async function mcpRpc<T>(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const session = await getSession(server, signal)
  try {
    return (await postRpc<T>(server, session, method, params, signal)).result
  } catch (err) {
    // 404 on a session request means the server dropped the session: start a new one, once.
    if (session.sessionId && (err as { status?: number }).status === 404) {
      sessions.delete(sessionKey(server))
      const fresh = await getSession(server, signal)
      return (await postRpc<T>(server, fresh, method, params, signal)).result
    }
    throw err
  }
}

/** Forget cached MCP sessions (tests, or after the user edits a server). */
export function resetMcpSessions(): void {
  sessions.clear()
}

export async function listMcpServerTools(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  signal?: AbortSignal
): Promise<McpToolSpec[]> {
  const res = await mcpRpc<{ tools?: McpToolSpec[] }>(server, "tools/list", {}, signal)
  return res.tools ?? []
}

export async function callMcpServerTool(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpToolCallResult> {
  return mcpRpc<McpToolCallResult>(server, "tools/call", { name, arguments: args }, signal)
}

/** Where a tool the assistant can call comes from. */
/** `sandbox`: the experimental local JS tool — always needs confirmation. */
export type ToolSource = "vfs" | "aa" | "external" | "sandbox"

export interface ToolConfirmationInfo {
  /** The tool's own name on its server (not the possibly prefixed name the model sees). */
  name: string
  source: ToolSource
  /** MCP `annotations.readOnlyHint`. */
  readOnlyHint?: boolean
}

const VFS_READ_ONLY = new Set(["vfs_ls", "vfs_read", "vfs_grep"])
const AA_READ_ONLY = new Set(["list_devices", "list_sessions", "read_session"])

/**
 * Whether a tool call needs explicit user confirmation (`beforeToolCall`, docs/v3/assistant-and-files-proposal.md §3).
 * Fails closed: only the known read-only built-in tools, and external tools their server marks `readOnlyHint`,
 * run without asking. The decision uses the tool's real source, so an external server cannot borrow a built-in
 * read-only name to skip confirmation.
 */
export function requiresToolConfirmation(tool: ToolConfirmationInfo): boolean {
  if (tool.source === "sandbox") return true
  if (tool.source === "vfs") return !VFS_READ_ONLY.has(tool.name)
  if (tool.source === "aa") return !AA_READ_ONLY.has(tool.name)
  return tool.readOnlyHint !== true
}
