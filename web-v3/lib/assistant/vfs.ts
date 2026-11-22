// Portable Assistant Virtual File System (Cloud VFS):
//   - Hot local cache in OPFS (Origin Private File System) with seamless IndexedDB fallback.
//   - Async SHA-256 content-hash sync with `server-v3` Cloud Drive (`purpose: "assistant_vfs"`).
//   - Encrypts uploaded blobs with the unlocked account DEK (`encryption_mode: "account_dek"`)
//     whenever assistant encryption is active.
//   - Exposes Pi Lite file tools (`vfs_ls`, `vfs_read`, `vfs_write`, `vfs_edit`, `vfs_grep`, `vfs_delete`).

import {
  completeDriveUpload,
  createDriveUpload,
  deleteDriveFile,
  fetchDriveDownloadUrl,
  listDriveFiles,
} from "@/lib/api/control-http"
import {
  decryptVfsFile,
  encryptVfsFile,
  sha256Hex,
} from "@/lib/assistant/crypto"
import { vault, type StoredVfsEntry } from "@/lib/storage/idb"

export interface VfsFileView {
  path: string
  name: string
  size: number
  sha256: string
  updatedAt: number
  synced: boolean
  encrypted: boolean
  driveFileId: string | null
}

export interface VfsSyncContext {
  accountId: string
  userId: string
  serverUrl: string
  getAccessToken: () => Promise<string>
  getEncryptionContext: () => {
    enabled: boolean
    dek: Uint8Array<ArrayBuffer> | null
    keyVersion: number | null
  }
}

export function normalizeWorkspacePath(input: string): string {
  const cleaned = input.trim().replace(/\\/g, "/")
  if (!cleaned) throw new Error("Path cannot be empty")
  const parts = cleaned.split("/").filter(Boolean)
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error("Path traversal ('..' or '.') is not allowed in Cloud VFS")
  }
  const normalized = `/${parts.join("/")}`
  if (!normalized.startsWith("/workspace/")) {
    if (normalized === "/workspace") return "/workspace"
    return `/workspace${normalized}`
  }
  return normalized
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text)
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength))
  out.set(encoded)
  return out
}

async function tryWriteOpfs(accountId: string, vfsPath: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return
    const root = await navigator.storage.getDirectory()
    const ns = await root.getDirectoryHandle("aa-assistant-vfs", { create: true })
    const acctDir = await ns.getDirectoryHandle(accountId.replace(/[^A-Za-z0-9_-]/g, "_"), {
      create: true,
    })
    const safeFile = vfsPath.replace(/[^A-Za-z0-9._-]/g, "__")
    const fh = await acctDir.getFileHandle(safeFile, { create: true })
    const writable = await fh.createWritable()
    await writable.write(bytes)
    await writable.close()
  } catch {
    // OPFS is a best-effort hot cache; IndexedDB always stores authoritative local copy.
  }
}

async function tryDeleteOpfs(accountId: string, vfsPath: string): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return
    const root = await navigator.storage.getDirectory()
    const ns = await root.getDirectoryHandle("aa-assistant-vfs")
    const acctDir = await ns.getDirectoryHandle(accountId.replace(/[^A-Za-z0-9_-]/g, "_"))
    const safeFile = vfsPath.replace(/[^A-Za-z0-9._-]/g, "__")
    await acctDir.removeEntry(safeFile)
  } catch {
    // ignore missing OPFS file
  }
}

function toView(entry: StoredVfsEntry): VfsFileView {
  const name = entry.path.split("/").filter(Boolean).at(-1) ?? entry.path
  return {
    path: entry.path,
    name,
    size: entry.size,
    sha256: entry.sha256,
    updatedAt: entry.updatedAt,
    synced: entry.syncedSha256 === entry.sha256,
    encrypted: entry.encrypted,
    driveFileId: entry.driveFileId,
  }
}

export class AssistantVfsManager {
  private readonly ctx: VfsSyncContext

  constructor(ctx: VfsSyncContext) {
    this.ctx = ctx
  }

  async listFiles(prefix = "/workspace"): Promise<VfsFileView[]> {
    const norm = prefix === "/workspace" ? "/workspace" : normalizeWorkspacePath(prefix)
    const entries = await vault.listVfsEntries(this.ctx.accountId)
    return entries
      .filter((e) => e.path === norm || e.path.startsWith(`${norm.replace(/\/$/, "")}/`))
      .map(toView)
  }

  async readText(rawPath: string): Promise<string> {
    const path = normalizeWorkspacePath(rawPath)
    const entry = await vault.getVfsEntry(this.ctx.accountId, path)
    if (!entry) throw new Error(`File not found in VFS: ${path}`)
    return new TextDecoder().decode(base64ToBytes(entry.contentBase64))
  }

  async readBytes(rawPath: string): Promise<Uint8Array<ArrayBuffer>> {
    const path = normalizeWorkspacePath(rawPath)
    const entry = await vault.getVfsEntry(this.ctx.accountId, path)
    if (!entry) throw new Error(`File not found in VFS: ${path}`)
    return base64ToBytes(entry.contentBase64)
  }

  async writeText(rawPath: string, content: string): Promise<VfsFileView> {
    const path = normalizeWorkspacePath(rawPath)
    const bytes = utf8Bytes(content)
    const digest = await sha256Hex(bytes)
    const existing = await vault.getVfsEntry(this.ctx.accountId, path)
    const enc = this.ctx.getEncryptionContext()
    const entry: StoredVfsEntry = {
      key: `${this.ctx.accountId}::${path}`,
      accountId: this.ctx.accountId,
      path,
      contentBase64: bytesToBase64(bytes),
      sha256: digest,
      size: bytes.byteLength,
      updatedAt: Date.now(),
      syncedSha256: existing?.syncedSha256 ?? null,
      driveFileId: existing?.driveFileId ?? null,
      encrypted: enc.enabled,
    }
    await vault.saveVfsEntry(entry)
    await tryWriteOpfs(this.ctx.accountId, path, bytes)
    return toView(entry)
  }

  async editText(rawPath: string, oldText: string, newText: string): Promise<VfsFileView> {
    const current = await this.readText(rawPath)
    if (!current.includes(oldText)) {
      throw new Error(`Target snippet not found in ${rawPath}`)
    }
    return this.writeText(rawPath, current.replace(oldText, newText))
  }

  async deleteFile(rawPath: string, syncCloud = true): Promise<boolean> {
    const path = normalizeWorkspacePath(rawPath)
    const existing = await vault.getVfsEntry(this.ctx.accountId, path)
    if (!existing) return false
    await vault.deleteVfsEntry(this.ctx.accountId, path)
    await tryDeleteOpfs(this.ctx.accountId, path)
    if (syncCloud && existing.driveFileId) {
      try {
        const token = await this.ctx.getAccessToken()
        await deleteDriveFile(this.ctx.serverUrl, token, existing.driveFileId)
      } catch {
        // Cloud drive might be disabled or already expired.
      }
    }
    return true
  }

  async grep(pattern: string, prefix = "/workspace"): Promise<{ path: string; line: number; text: string }[]> {
    const regex = new RegExp(pattern, "i")
    const files = await this.listFiles(prefix)
    const matches: { path: string; line: number; text: string }[] = []
    for (const file of files) {
      const content = await this.readText(file.path)
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ path: file.path, line: i + 1, text: lines[i].slice(0, 240) })
          if (matches.length >= 100) return matches
        }
      }
    }
    return matches
  }

  /**
   * Synchronize local OPFS/IDB VFS files with `server-v3` Cloud Drive (`purpose: "assistant_vfs"`).
   * Pushes locally modified files (encrypting with DEK when encryption is enabled) and pulls remote files.
   */
  async syncWithCloudDrive(): Promise<{ uploaded: number; downloaded: number; enabled: boolean }> {
    const token = await this.ctx.getAccessToken()
    const remote = await listDriveFiles(this.ctx.serverUrl, token, {
      purpose: "assistant_vfs",
      limit: 200,
    })
    if (!remote.quota.enabled) {
      return { uploaded: 0, downloaded: 0, enabled: false }
    }

    const enc = this.ctx.getEncryptionContext()
    if (enc.enabled && !enc.dek) {
      throw new Error("Unlock assistant encryption password before syncing encrypted VFS files")
    }

    let uploaded = 0
    let downloaded = 0

    const localEntries = await vault.listVfsEntries(this.ctx.accountId)
    const localByPath = new Map(localEntries.map((e) => [e.path, e]))
    const remoteByPath = new Map(
      remote.files.filter((f) => f.vfs_path).map((f) => [f.vfs_path!, f])
    )

    // 1. Push dirty local files
    for (const entry of localEntries) {
      if (entry.syncedSha256 === entry.sha256) continue
      const plainBytes = base64ToBytes(entry.contentBase64)
      const filename = entry.path.split("/").filter(Boolean).at(-1) ?? "file.txt"

      let uploadBytes: Uint8Array<ArrayBuffer> = plainBytes
      let encryptionMode: "none" | "account_dek" = "none"
      let encryptionNonce: string | null = null
      let encryptedMeta: string | null = null
      let keyVersion: number | null = null

      if (enc.enabled && enc.dek && enc.keyVersion) {
        const sealed = await encryptVfsFile(enc.dek, this.ctx.userId, entry.path, plainBytes, filename)
        uploadBytes = sealed.ciphertext
        encryptionMode = "account_dek"
        encryptionNonce = sealed.nonce
        encryptedMeta = sealed.encryptedMeta
        keyVersion = enc.keyVersion
      }

      const uploadSha = await sha256Hex(uploadBytes)
      const created = await createDriveUpload(this.ctx.serverUrl, token, {
        purpose: "assistant_vfs",
        size_bytes: uploadBytes.byteLength,
        sha256: uploadSha,
        filename: encryptionMode === "none" ? filename : null,
        mime_type: "text/plain; charset=utf-8",
        vfs_path: entry.path,
        encryption_mode: encryptionMode,
        encryption_nonce: encryptionNonce,
        encryption_key_version: keyVersion,
        encrypted_meta: encryptedMeta,
      })

      const putRes = await fetch(created.upload.url, {
        method: "PUT",
        headers: created.upload.headers,
        body: uploadBytes,
      })
      if (!putRes.ok) {
        throw new Error(`Object storage upload failed for ${entry.path} (${putRes.status})`)
      }
      const etag = putRes.headers.get("etag")
      const completed = await completeDriveUpload(
        this.ctx.serverUrl,
        token,
        created.file.id,
        etag
      )
      await vault.saveVfsEntry({
        ...entry,
        syncedSha256: entry.sha256,
        driveFileId: completed.id,
        encrypted: encryptionMode === "account_dek",
      })
      uploaded++
    }

    // 2. Pull cloud files not yet present locally (or updated remotely while local is clean)
    for (const [vfsPath, file] of remoteByPath) {
      const local = localByPath.get(vfsPath)
      if (local && local.driveFileId === file.id) continue
      if (local && local.syncedSha256 !== local.sha256) continue // keep local dirty copy

      const dl = await fetchDriveDownloadUrl(this.ctx.serverUrl, token, file.id)
      const dlRes = await fetch(dl.download.url, { headers: dl.download.headers })
      if (!dlRes.ok) continue
      const rawBuf = await dlRes.arrayBuffer()
      let plainBytes = new Uint8Array(new ArrayBuffer(rawBuf.byteLength))
      plainBytes.set(new Uint8Array(rawBuf))

      if (file.encryption_mode === "account_dek") {
        if (!enc.dek || !file.encryption_nonce) continue
        plainBytes = await decryptVfsFile(
          enc.dek,
          this.ctx.userId,
          vfsPath,
          file.encryption_nonce,
          plainBytes
        )
      }

      const plainSha = await sha256Hex(plainBytes)
      await vault.saveVfsEntry({
        key: `${this.ctx.accountId}::${vfsPath}`,
        accountId: this.ctx.accountId,
        path: vfsPath,
        contentBase64: bytesToBase64(plainBytes),
        sha256: plainSha,
        size: plainBytes.byteLength,
        updatedAt: Date.parse(file.completed_at ?? file.created_at) || Date.now(),
        syncedSha256: plainSha,
        driveFileId: file.id,
        encrypted: file.encryption_mode === "account_dek",
      })
      await tryWriteOpfs(this.ctx.accountId, vfsPath, plainBytes)
      downloaded++
    }

    return { uploaded, downloaded, enabled: true }
  }
}
