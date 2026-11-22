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

let rpcSeq = 1

async function mcpRpc<T>(
  server: Pick<AssistantMcpServerConfig, "url" | "token">,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  if (server.token) {
    headers.Authorization = `Bearer ${server.token}`
  }

  const res = await fetch(server.url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method, params }),
  })

  const text = await res.text()
  let parsed: { result?: T; error?: { message?: string } } | null = null
  if (text.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(text) as { result?: T; error?: { message?: string } }
    } catch {
      parsed = null
    }
  } else if (text.includes("data:")) {
    // Some Streamable HTTP MCP servers wrap a single JSON-RPC reply in an SSE frame.
    const dataLine = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim()
    if (dataLine) {
      try {
        parsed = JSON.parse(dataLine) as { result?: T; error?: { message?: string } }
      } catch {
        parsed = null
      }
    }
  }

  if (!res.ok) {
    throw new McpClientError(parsed?.error?.message ?? `MCP request failed (${res.status})`)
  }
  if (parsed?.error) {
    throw new McpClientError(parsed.error.message ?? "MCP error")
  }
  if (!parsed || parsed.result === undefined) {
    throw new McpClientError("MCP server returned an empty or unreadable response")
  }
  return parsed.result
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

const READ_ONLY_TOOLS = new Set([
  "list_devices",
  "list_sessions",
  "read_session",
  "vfs_ls",
  "vfs_read",
  "vfs_grep",
])

const ALWAYS_CONFIRM_PATTERNS = [
  /answer_approval/i,
  /delete/i,
  /remove/i,
  /revoke/i,
  /drop/i,
  /stop_session/i,
  /create_session/i,
  /send_message/i,
  /vfs_write/i,
  /vfs_edit/i,
  /vfs_delete/i,
  /write|edit|exec|run|shell|post|put|patch|create|update/i,
]

/**
 * Determine whether a tool call requires explicit user confirmation before executing
 * (`beforeToolCall` hook per docs/v3/assistant-and-files-proposal.md §3).
 */
export function requiresToolConfirmation(toolName: string): boolean {
  const bare = toolName.includes("__") ? toolName.split("__").slice(1).join("__") : toolName
  if (READ_ONLY_TOOLS.has(bare)) return false
  return ALWAYS_CONFIRM_PATTERNS.some((re) => re.test(bare))
}
