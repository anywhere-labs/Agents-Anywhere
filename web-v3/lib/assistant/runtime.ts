// Lazy-loaded Pi Lite runtime (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`).
// Dynamically imported ONLY when the user runs the Portable Assistant so none of this enters
// the initial page bundle.
//
// Preserves Effi's proven browser compatibility fixes (docs/v3/assistant-and-files-proposal.md §3):
//   - Drops script-set `User-Agent` header (`'User-Agent': null`) so Safari/Firefox CORS preflight succeeds.
//   - Drops attribution headers (`identity: { attribution: null }`).
//   - Uses explicit Anthropic thinking budget (strips `forceAdaptiveThinking` & mid-convo compat flags).

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
} from "@earendil-works/pi-agent-core"
import type { Api, Model } from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { clampThinkingLevel, createModels, createProvider } from "@earendil-works/pi-ai/models"

import {
  callMcpServerTool,
  listMcpServerTools,
  requiresToolConfirmation,
  type ToolConfirmationInfo,
} from "@/lib/assistant/mcp-client"
import { prettyModelName, type ModelFormat } from "@/lib/assistant/tokens"
import type { AssistantVfsManager } from "@/lib/assistant/vfs"
import type { AssistantMcpServerConfig, AssistantModelPref } from "@/lib/storage/idb"

export interface AssistantModelChoice {
  format: ModelFormat
  baseUrl: string
  model: string
  apiKey: string
  name?: string
  thinking?: AssistantModelPref["thinking"]
  webSearch?: boolean
}

export type ToolConfirmFn = (call: {
  id: string
  name: string
  args: Record<string, unknown>
}) => Promise<boolean>

export interface CreatePiLiteOptions {
  choice: AssistantModelChoice
  systemPrompt: string
  messages?: AgentMessage[]
  vfs?: AssistantVfsManager
  mcpServers?: AssistantMcpServerConfig[]
  confirm: ToolConfirmFn
}

const PROVIDER_ID = "aa-pi-lite"

const ANTHROPIC_STRIP_COMPAT = [
  "forceAdaptiveThinking",
  "supportsMidConvoEffort",
  "supportsMidConvoSystemMessages",
  "supportsMidConvoToolChanges",
] as const

function buildModel(choice: AssistantModelChoice): Model<Api> {
  const baseUrl = choice.baseUrl.replace(/\/+$/, "")
  const reasoning =
    choice.thinking !== "off" &&
    /claude|o1|o3|o4|gpt-5|deepseek-r|deepseek-v4|gemini-2\.5|gemini-3/i.test(choice.model)
  const compat: Record<string, unknown> = {}
  if (choice.format === "anthropic-messages") {
    for (const k of ANTHROPIC_STRIP_COMPAT) delete compat[k]
  }
  return {
    id: choice.model,
    name: choice.name ?? prettyModelName(choice.model),
    api: choice.format,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    input: /deepseek/i.test(choice.model) ? ["text"] : ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    compat,
  } as unknown as Model<Api>
}

function withWebSearch(payload: unknown, api: string): unknown {
  const p = payload as { tools?: unknown[] }
  if (api === "anthropic-messages") {
    return {
      ...p,
      tools: [...(p.tools ?? []), { type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }
  }
  if (api === "openai-responses") {
    return { ...p, tools: [...(p.tools ?? []), { type: "web_search" }] }
  }
  return undefined
}

function buildVfsTools(vfs: AssistantVfsManager): AgentTool[] {
  return [
    {
      name: "vfs_ls",
      label: "vfs_ls",
      description: "List files in the assistant's Cloud VFS workspace (/workspace).",
      parameters: {
        type: "object",
        properties: { prefix: { type: "string", description: "Optional directory prefix under /workspace" } },
      } as never,
      executionMode: "sequential",
      async execute(_id, params) {
        const prefix = typeof (params as { prefix?: string })?.prefix === "string" ? (params as { prefix?: string }).prefix : "/workspace"
        const files = await vfs.listFiles(prefix)
        const text = files.length
          ? files.map((f) => `${f.path} (${f.size} B, ${f.synced ? "synced" : "local"})`).join("\n")
          : "(empty workspace)"
        return { content: [{ type: "text", text }], details: { count: files.length } }
      },
    },
    {
      name: "vfs_read",
      label: "vfs_read",
      description: "Read a UTF-8 text file from the assistant's Cloud VFS (/workspace/...).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path under /workspace" } },
        required: ["path"],
      } as never,
      executionMode: "sequential",
      async execute(_id, params) {
        const path = String((params as { path: string }).path)
        const text = await vfs.readText(path)
        return { content: [{ type: "text", text }], details: { path } }
      },
    },
    {
      name: "vfs_write",
      label: "vfs_write",
      description: "Create or overwrite a UTF-8 text file in the assistant's Cloud VFS.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      } as never,
      executionMode: "sequential",
      async execute(_id, params) {
        const { path, content } = params as { path: string; content: string }
        const file = await vfs.writeText(path, content)
        return {
          content: [{ type: "text", text: `Saved ${file.path} (${file.size} bytes)` }],
          details: file,
        }
      },
    },
    {
      name: "vfs_edit",
      label: "vfs_edit",
      description: "Replace an exact substring in a Cloud VFS text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      } as never,
      executionMode: "sequential",
      async execute(_id, params) {
        const { path, old_text, new_text } = params as {
          path: string
          old_text: string
          new_text: string
        }
        const file = await vfs.editText(path, old_text, new_text)
        return {
          content: [{ type: "text", text: `Updated ${file.path} (${file.size} bytes)` }],
          details: file,
        }
      },
    },
    {
      name: "vfs_grep",
      label: "vfs_grep",
      description: "Search across files in the assistant's Cloud VFS using a regex pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          prefix: { type: "string" },
        },
        required: ["pattern"],
      } as never,
      executionMode: "sequential",
      async execute(_id, params) {
        const { pattern, prefix } = params as { pattern: string; prefix?: string }
        const hits = await vfs.grep(pattern, prefix)
        const text = hits.length
          ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n")
          : "(no matches)"
        return { content: [{ type: "text", text }], details: { count: hits.length } }
      },
    },
    {
      name: "vfs_delete",
      label: "vfs_delete",
      description: "Delete a file from the assistant's Cloud VFS.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      } as never,
      executionMode: "sequential",
      async execute(_id, params) {
        const path = String((params as { path: string }).path)
        const deleted = await vfs.deleteFile(path)
        return {
          content: [{ type: "text", text: deleted ? `Deleted ${path}` : `Not found: ${path}` }],
          details: { path, deleted },
        }
      },
    },
  ]
}

/** Provider tool names: `^[a-zA-Z0-9_-]{1,64}$`, unique within one request. */
function toolNameSlug(raw: string, fallback: string): string {
  const slug = raw.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  return slug || fallback
}

function uniqueToolName(wanted: string, prefix: string, used: Set<string>): string {
  const candidates = [wanted, `${prefix}__${wanted}`]
  for (const candidate of candidates) {
    const name = candidate.slice(0, 64)
    if (!used.has(name)) return name
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`
    const name = `${prefix}__${wanted}`.slice(0, 64 - suffix.length) + suffix
    if (!used.has(name)) return name
  }
}

interface BuiltMcpTools {
  tools: AgentTool[]
  info: Map<string, ToolConfirmationInfo>
  errors: { server: string; message: string }[]
}

async function buildMcpTools(
  servers: AssistantMcpServerConfig[],
  usedNames: Set<string>
): Promise<BuiltMcpTools> {
  // AA's own server first, so its tools keep their documented names when they are free.
  const enabled = servers
    .filter((s) => s.enabled)
    .sort((a, b) => Number(Boolean(b.isBuiltInAA)) - Number(Boolean(a.isBuiltInAA)))
  const out: AgentTool[] = []
  const info = new Map<string, ToolConfirmationInfo>()
  const errors: { server: string; message: string }[] = []

  for (const server of enabled) {
    let specs
    try {
      specs = await listMcpServerTools(server)
    } catch (err) {
      // An unreachable optional MCP server should not stop the assistant, but the user should know.
      errors.push({ server: server.name, message: err instanceof Error ? err.message : String(err) })
      continue
    }
    const prefix = toolNameSlug(server.name.toLowerCase(), "mcp")
    for (const spec of specs) {
      const toolName = uniqueToolName(toolNameSlug(spec.name, "tool"), prefix, usedNames)
      usedNames.add(toolName)
      info.set(toolName, {
        name: spec.name,
        source: server.isBuiltInAA ? "aa" : "external",
        readOnlyHint: spec.annotations?.readOnlyHint === true,
      })
      const parameters = { ...(spec.inputSchema as Record<string, unknown>) }
      delete parameters.title
      out.push({
        name: toolName,
        label: `${server.name}: ${spec.name}`,
        description: spec.description ?? "",
        parameters: parameters as never,
        executionMode: "sequential",
        async execute(_id, params, signal) {
          const res = await callMcpServerTool(
            server,
            spec.name,
            (params ?? {}) as Record<string, unknown>,
            signal
          )
          const text = res.content.map((c) => c.text ?? "").join("\n")
          return {
            content: [{ type: "text", text }],
            details: { server: server.name, tool: spec.name, isError: res.isError },
          }
        },
      })
    }
  }
  return { tools: out, info, errors }
}

export async function createPiLiteAgent(options: CreatePiLiteOptions): Promise<{
  agent: Agent
  toolCount: number
  /** MCP servers whose tools could not be loaded. */
  mcpErrors: { server: string; message: string }[]
}> {
  const model = buildModel(options.choice)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: options.choice.name ?? "Agents Anywhere",
      auth: {
        apiKey: {
          name: "API Key",
          resolve: async () => ({ auth: { apiKey: options.choice.apiKey } }),
        },
      },
      models: [model],
      api: {
        "anthropic-messages": anthropicMessagesApi(),
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
      },
    })
  )

  const vfsTools = options.vfs ? buildVfsTools(options.vfs) : []
  const toolInfo = new Map<string, ToolConfirmationInfo>(
    vfsTools.map((t) => [t.name, { name: t.name, source: "vfs" }])
  )
  const usedNames = new Set(vfsTools.map((t) => t.name))
  const mcp = options.mcpServers?.length
    ? await buildMcpTools(options.mcpServers, usedNames)
    : { tools: [], info: new Map<string, ToolConfirmationInfo>(), errors: [] }
  for (const [name, entry] of mcp.info) toolInfo.set(name, entry)
  const tools = [...vfsTools, ...mcp.tools]

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model,
      tools,
      thinkingLevel: clampThinkingLevel(model, options.choice.thinking ?? "medium"),
      messages: options.messages ?? [],
    },
    // Drop script User-Agent header for Safari/Firefox CORS preflight compatibility.
    streamFn: (m, ctx, opts) =>
      models.streamSimple(m, ctx, {
        ...opts,
        headers: { ...opts?.headers, "User-Agent": null } as unknown as Record<string, string>,
      }),
    getApiKey: () => options.choice.apiKey,
    identity: { attribution: null },
    toolExecution: "sequential",
    onPayload: (payload, m) =>
      options.choice.webSearch ? withWebSearch(payload, m.api) : undefined,
    beforeToolCall: async ({ toolCall, args }: BeforeToolCallContext) => {
      // A name we did not hand out is treated as external: it needs confirmation.
      const info = toolInfo.get(toolCall.name) ?? { name: toolCall.name, source: "external" as const }
      if (!requiresToolConfirmation(info)) return undefined
      const ok = await options.confirm({
        id: toolCall.id,
        name: toolCall.name,
        args: (args ?? {}) as Record<string, unknown>,
      })
      return ok
        ? undefined
        : {
            block: true,
            reason:
              "User declined this tool execution. Ask the user how they would like to proceed instead of retrying.",
          }
    },
  })

  return { agent, toolCount: tools.length, mcpErrors: mcp.errors }
}

export type { Agent, AgentEvent, AgentMessage }
