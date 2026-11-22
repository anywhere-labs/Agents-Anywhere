import "fake-indexeddb/auto"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  assessPassphraseStrength,
  decryptConversation,
  decryptVfsFile,
  encryptConversation,
  encryptVfsFile,
  generateDek,
  unwrapDekWithPassword,
  wrapDekWithPassword,
} from "@/lib/assistant/crypto"
import { listMcpServerTools, requiresToolConfirmation, resetMcpSessions } from "@/lib/assistant/mcp-client"
import { resolveSyncDecision } from "@/lib/assistant/sync"
import { AssistantVfsManager, normalizeWorkspacePath } from "@/lib/assistant/vfs"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Portable Assistant any-password KEK/DEK encryption", () => {
  it("accepts ANY user password (including short PINs) while advising on strength", async () => {
    expect(assessPassphraseStrength("1234")).toBe("short")
    expect(assessPassphraseStrength("correct-horse-99!")).toBe("strong")

    const dek = generateDek()
    // Fast iteration count for unit test speed; production default is 600_000
    const wrapped = await wrapDekWithPassword("1234", dek, 10_000)
    const unwrapped = await unwrapDekWithPassword("1234", wrapped)
    expect(Array.from(unwrapped)).toEqual(Array.from(dek))

    // Wrong password must fail AES-GCM authentication
    await expect(unwrapDekWithPassword("wrong", wrapped)).rejects.toThrow()

    // Password change re-wraps the EXACT SAME DEK without re-encrypting conversations
    const rotatedWrap = await wrapDekWithPassword("new-strong-Pass!42", dek, 10_000)
    const unwrappedAfterRotate = await unwrapDekWithPassword("new-strong-Pass!42", rotatedWrap)
    expect(Array.from(unwrappedAfterRotate)).toEqual(Array.from(dek))
  })

  it("authenticates conversation & VFS ciphertexts with AAD to block cross-record swaps", async () => {
    const dek = generateDek()

    const encConv = await encryptConversation(dek, "user-1", "conv-A", {
      title: "Private strategy",
      settings: { model: "claude" },
      messages: [{ role: "user", content: "Secret plan" }],
    })
    const plainConv = await decryptConversation(
      dek,
      "user-1",
      "conv-A",
      encConv.nonce,
      encConv.ciphertext
    )
    expect(plainConv.title).toBe("Private strategy")
    expect(plainConv.messages).toHaveLength(1)

    // Swapping ciphertext to another conversationId or userId MUST fail GCM tag check
    await expect(
      decryptConversation(dek, "user-1", "conv-B", encConv.nonce, encConv.ciphertext)
    ).rejects.toThrow()
    await expect(
      decryptConversation(dek, "user-2", "conv-A", encConv.nonce, encConv.ciphertext)
    ).rejects.toThrow()

    const rawBytes = new TextEncoder().encode("hello cloud vfs")
    const encFile = await encryptVfsFile(dek, "user-1", "/workspace/notes.md", rawBytes, "notes.md")
    const decFile = await decryptVfsFile(
      dek,
      "user-1",
      "/workspace/notes.md",
      encFile.nonce,
      encFile.ciphertext
    )
    expect(new TextDecoder().decode(decFile)).toBe("hello cloud vfs")

    await expect(
      decryptVfsFile(dek, "user-1", "/workspace/other.md", encFile.nonce, encFile.ciphertext)
    ).rejects.toThrow()
  })
})

describe("Dual-fingerprint 3-way Assistant sync decision matrix", () => {
  it("handles noop, pull, push, open conflict, and background auto-fork", () => {
    expect(
      resolveSyncDecision({ localHash: "h1", syncedHash: "h1", cloudHash: "h1", isOpen: true })
    ).toBe("noop")
    expect(
      resolveSyncDecision({ localHash: null, syncedHash: null, cloudHash: "h1", isOpen: false })
    ).toBe("pull")
    expect(
      resolveSyncDecision({ localHash: "h1", syncedHash: null, cloudHash: null, isOpen: false })
    ).toBe("push")
    expect(
      resolveSyncDecision({ localHash: "h1", syncedHash: "h1", cloudHash: "h2", isOpen: true })
    ).toBe("pull")
    expect(
      resolveSyncDecision({ localHash: "h2", syncedHash: "h1", cloudHash: "h1", isOpen: true })
    ).toBe("push")
    expect(
      resolveSyncDecision({ localHash: "h2", syncedHash: "h1", cloudHash: "h3", isOpen: true })
    ).toBe("conflict")
    expect(
      resolveSyncDecision({ localHash: "h2", syncedHash: "h1", cloudHash: "h3", isOpen: false })
    ).toBe("fork_local")
  })
})

describe("Cloud VFS path safety, CRUD, grep & encrypted Drive sync", () => {
  it("normalizes paths under /workspace and rejects traversal", () => {
    expect(normalizeWorkspacePath("notes.md")).toBe("/workspace/notes.md")
    expect(normalizeWorkspacePath("/workspace/dir/file.ts")).toBe("/workspace/dir/file.ts")
    expect(() => normalizeWorkspacePath("/workspace/../etc/passwd")).toThrow()
    expect(() => normalizeWorkspacePath("./secret")).toThrow()
  })

  it("writes, reads, edits, greps, and uploads encrypted blobs with account_dek", async () => {
    const dek = generateDek()
    let uploadedEncryptionMode: string | null = null
    let uploadedWireBytes: Uint8Array | null = null

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/drive/files?purpose=assistant_vfs")) {
        return new Response(
          JSON.stringify({
            files: [],
            quota: {
              enabled: true,
              rpc_direct_max_bytes: 8 * 1024 * 1024,
              quota_bytes: 512 * 1024 * 1024,
              used_bytes: 0,
              reserved_bytes: 0,
              remaining_bytes: 512 * 1024 * 1024,
              max_file_bytes: 64 * 1024 * 1024,
              default_ttl_seconds: 604800,
              max_ttl_seconds: 2592000,
              file_count: 0,
              policy_source: "default",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      if (url.endsWith("/drive/uploads")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { encryption_mode?: string }
        uploadedEncryptionMode = body.encryption_mode ?? null
        return new Response(
          JSON.stringify({
            file: { id: "df_1", vfs_path: "/workspace/todo.md", status: "pending" },
            upload: {
              method: "PUT",
              url: "https://s3.mock/upload/df_1",
              headers: {},
              expires_at: "2026-11-23T00:00:00Z",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        )
      }
      if (url === "https://s3.mock/upload/df_1") {
        uploadedWireBytes =
          init?.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(await new Response(init?.body).arrayBuffer())
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } })
      }
      if (url.endsWith("/drive/files/df_1/complete")) {
        return new Response(JSON.stringify({ id: "df_1", status: "ready" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const vfs = new AssistantVfsManager({
      accountId: "https://aa.local::u-vfs",
      userId: "u-vfs",
      serverUrl: "https://aa.local",
      getAccessToken: async () => "token-1",
      getEncryptionContext: () => ({ enabled: true, dek, keyVersion: 1 }),
    })

    await vfs.writeText("todo.md", "Alpha secret line\nBeta item")
    expect(await vfs.readText("/workspace/todo.md")).toContain("Alpha secret line")

    await vfs.editText("/workspace/todo.md", "Beta item", "Gamma done")
    expect(await vfs.grep("Gamma")).toEqual([
      { path: "/workspace/todo.md", line: 2, text: "Gamma done" },
    ])

    const syncRes = await vfs.syncWithCloudDrive()
    expect(syncRes.enabled).toBe(true)
    expect(syncRes.uploaded).toBe(1)
    expect(uploadedEncryptionMode).toBe("account_dek")
    // Ciphertext sent to S3 must NOT contain the plaintext phrase!
    const wireText = new TextDecoder().decode(uploadedWireBytes ?? new Uint8Array())
    expect(wireText).not.toContain("Alpha secret line")

    await vfs.deleteFile("/workspace/todo.md")
    expect(await vfs.listFiles()).toEqual([])
  })
})

describe("Cloud VFS with encryption on", () => {
  it("never uploads plaintext when the key version is not loaded yet", async () => {
    const dek = generateDek()
    const requests: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/drive/files?purpose=assistant_vfs")) {
        return new Response(JSON.stringify({ files: [], quota: { enabled: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("unexpected", { status: 500 })
    }))
    try {
      const vfs = new AssistantVfsManager({
        accountId: "https://aa.local::u-vfs-nokv",
        userId: "u-vfs-nokv",
        serverUrl: "https://aa.local",
        getAccessToken: async () => "token-1",
        getEncryptionContext: () => ({ enabled: true, dek, keyVersion: null }),
      })
      await vfs.writeText("secret.md", "do not leak")
      await expect(vfs.syncWithCloudDrive()).rejects.toThrow(/not ready/)
      expect(requests.some((u) => u.endsWith("/drive/uploads"))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("MCP tool confirmation policy", () => {
  it("runs only known read-only built-in tools without asking", () => {
    expect(requiresToolConfirmation({ name: "list_devices", source: "aa" })).toBe(false)
    expect(requiresToolConfirmation({ name: "list_sessions", source: "aa" })).toBe(false)
    expect(requiresToolConfirmation({ name: "vfs_read", source: "vfs" })).toBe(false)
    expect(requiresToolConfirmation({ name: "vfs_grep", source: "vfs" })).toBe(false)

    expect(requiresToolConfirmation({ name: "send_message", source: "aa" })).toBe(true)
    expect(requiresToolConfirmation({ name: "create_session", source: "aa" })).toBe(true)
    expect(requiresToolConfirmation({ name: "answer_approval", source: "aa" })).toBe(true)
    expect(requiresToolConfirmation({ name: "vfs_write", source: "vfs" })).toBe(true)
    expect(requiresToolConfirmation({ name: "vfs_delete", source: "vfs" })).toBe(true)
  })

  it("asks for every external tool unless its server marks it read-only", () => {
    // Names no pattern list would catch.
    expect(requiresToolConfirmation({ name: "send_email", source: "external" })).toBe(true)
    expect(requiresToolConfirmation({ name: "git_push", source: "external" })).toBe(true)
    // An external server cannot borrow a built-in read-only name.
    expect(requiresToolConfirmation({ name: "vfs_read", source: "external" })).toBe(true)
    expect(requiresToolConfirmation({ name: "list_sessions", source: "external" })).toBe(true)
    expect(requiresToolConfirmation({ name: "search_docs", source: "external", readOnlyHint: true })).toBe(false)
  })
})

describe("Streamable HTTP MCP client", () => {
  it("initializes once, then sends the session id on every request", async () => {
    resetMcpSessions()
    const seen: { method: string; session: string | null; protocol: string | null }[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      const body = JSON.parse(String(init.body)) as { method: string; id?: number }
      seen.push({ method: body.method, session: headers.get("mcp-session-id"), protocol: headers.get("mcp-protocol-version") })
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" },
        })
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search_docs", inputSchema: {} }] } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const server = { url: "https://mcp.example.test/mcp" }
      expect((await listMcpServerTools(server)).map((t) => t.name)).toEqual(["search_docs"])
      await listMcpServerTools(server)
      expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"])
      expect(seen[0]?.session).toBeNull()
      for (const later of seen.slice(1)) {
        expect(later.session).toBe("sess-1")
        expect(later.protocol).toBe("2025-06-18")
      }
    } finally {
      vi.unstubAllGlobals()
      resetMcpSessions()
    }
  })

  it("starts a new session when the server forgets the old one", async () => {
    resetMcpSessions()
    let sessionNo = 0
    const methods: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      const body = JSON.parse(String(init.body)) as { method: string; id?: number }
      methods.push(body.method)
      if (body.method === "initialize") {
        sessionNo++
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          headers: { "Mcp-Session-Id": `sess-${sessionNo}` },
        })
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (headers.get("mcp-session-id") === "sess-1") return new Response("gone", { status: 404 })
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }))
    }))
    try {
      expect(await listMcpServerTools({ url: "https://mcp.example.test/mcp" })).toEqual([])
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "initialize", "notifications/initialized", "tools/list"])
    } finally {
      vi.unstubAllGlobals()
      resetMcpSessions()
    }
  })
})
