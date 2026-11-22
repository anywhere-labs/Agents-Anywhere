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
import { requiresToolConfirmation } from "@/lib/assistant/mcp-client"
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

describe("MCP tool confirmation policy", () => {
  it("allows read-only tools automatically and requires confirmation for write/high-impact tools", () => {
    expect(requiresToolConfirmation("list_devices")).toBe(false)
    expect(requiresToolConfirmation("list_sessions")).toBe(false)
    expect(requiresToolConfirmation("vfs_read")).toBe(false)
    expect(requiresToolConfirmation("vfs_grep")).toBe(false)

    expect(requiresToolConfirmation("send_message")).toBe(true)
    expect(requiresToolConfirmation("create_session")).toBe(true)
    expect(requiresToolConfirmation("answer_approval")).toBe(true)
    expect(requiresToolConfirmation("vfs_write")).toBe(true)
    expect(requiresToolConfirmation("vfs_delete")).toBe(true)
    expect(requiresToolConfirmation("external__delete_record")).toBe(true)
  })
})
