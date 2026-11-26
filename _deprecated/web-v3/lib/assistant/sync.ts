// Dual-fingerprint whole-conversation cloud sync engine for Portable Assistant.
// Follows docs/v3/assistant-and-files-proposal.md §4 & §5 and Effi's assistant sync model:
//   - Server stores whole conversations without judging newer/older and broadcasts via Redis Pub/Sub SSE.
//   - Client tracks local `hash`, last agreed cloud `syncedHash`, and active tab's `agreedHash`:
//       * Only cloud changed -> pull silently
//       * Only local changed -> push to cloud
//       * Both changed & conversation is currently open -> prompt conflict dialog
//       * Both changed & NOT open -> auto-fork local as "(本机)" under a new id and accept cloud on original id

import {
  deleteAssistantConversation,
  getAssistantConversation,
  listAssistantConversations,
  putAssistantConversation,
} from "@/lib/api/control-http"
import {
  computeConversationHash,
  decryptConversation,
  encryptConversation,
} from "@/lib/assistant/crypto"
import { vault, type LocalAssistantConversation } from "@/lib/storage/idb"
import type { AssistantConversationDetail } from "@/lib/types/v3"

export type SyncDecision = "noop" | "push" | "pull" | "conflict" | "fork_local"

export interface SyncDecisionInput {
  localHash: string | null
  syncedHash: string | null
  cloudHash: string | null
  isOpen: boolean
}

/**
 * Pure 3-way fingerprint decision rule (docs/v3/assistant-and-files-proposal.md §4).
 */
export function resolveSyncDecision(input: SyncDecisionInput): SyncDecision {
  const { localHash, syncedHash, cloudHash, isOpen } = input
  if (localHash === cloudHash) return "noop"
  if (!localHash && cloudHash) return "pull"
  if (localHash && !cloudHash) return "push"

  const localChanged = localHash !== syncedHash
  const cloudChanged = cloudHash !== syncedHash

  if (!localChanged && cloudChanged) return "pull"
  if (localChanged && !cloudChanged) return "push"
  return isOpen ? "conflict" : "fork_local"
}

export interface AssistantSyncConflict {
  id: string
  localTitle: string
  cloudTitle: string
  cloudHash: string
  cloudUpdatedAt: number
  cloudMessages: Record<string, unknown>[]
  cloudSettings: Record<string, unknown> | null
}

export interface AssistantSyncContext {
  accountId: string
  userId: string
  serverUrl: string
  deviceTabId: string
  getAccessToken: () => Promise<string>
  getEncryption: () => {
    enabled: boolean
    dek: Uint8Array<ArrayBuffer> | null
    keyVersion: number | null
    dekEpoch: number | null
  }
}

export function newConversationId(): string {
  return `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function decodeCloudConversation(
  ctx: AssistantSyncContext,
  detail: AssistantConversationDetail
): Promise<{
  title: string
  messages: Record<string, unknown>[]
  settings: Record<string, unknown> | null
  encrypted: boolean
}> {
  if (!detail.encrypted) {
    return {
      title: detail.title ?? "Untitled",
      messages: detail.messages ?? [],
      settings: detail.settings ?? null,
      encrypted: false,
    }
  }
  const enc = ctx.getEncryption()
  if (!enc.dek || !detail.nonce || !detail.ciphertext) {
    throw new Error("Assistant encryption key is locked; unlock with your password to read")
  }
  const plain = await decryptConversation(
    enc.dek,
    ctx.userId,
    detail.id,
    detail.nonce,
    detail.ciphertext
  )
  return {
    title: plain.title,
    messages: plain.messages,
    settings: plain.settings,
    encrypted: true,
  }
}

export async function pushConversationToCloud(
  ctx: AssistantSyncContext,
  conv: LocalAssistantConversation
): Promise<LocalAssistantConversation> {
  const token = await ctx.getAccessToken()
  const enc = ctx.getEncryption()
  const hash = await computeConversationHash(conv.title, conv.messages, conv.settings)

  let body: Record<string, unknown>
  if (enc.enabled) {
    if (!enc.dek || !enc.keyVersion || !enc.dekEpoch) {
      throw new Error("Assistant encryption is enabled; unlock your password before syncing")
    }
    const sealed = await encryptConversation(enc.dek, ctx.userId, conv.id, {
      title: conv.title,
      settings: conv.settings,
      messages: conv.messages,
    })
    body = {
      encrypted: true,
      updated_at: conv.updatedAt,
      hash,
      device: ctx.deviceTabId,
      key_version: enc.keyVersion,
      dek_epoch: enc.dekEpoch,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      encrypted_meta: sealed.encrypted_meta,
      meta_nonce: sealed.meta_nonce,
    }
  } else {
    body = {
      encrypted: false,
      title: conv.title.slice(0, 200),
      updated_at: conv.updatedAt,
      hash,
      device: ctx.deviceTabId,
      messages: conv.messages,
      settings: conv.settings,
    }
  }

  await putAssistantConversation(ctx.serverUrl, token, conv.id, body)
  const synced: LocalAssistantConversation = {
    ...conv,
    hash,
    syncedHash: hash,
    encrypted: enc.enabled,
  }
  await vault.saveAssistantConversation(synced)
  return synced
}

export async function pullConversationFromCloud(
  ctx: AssistantSyncContext,
  conversationId: string
): Promise<LocalAssistantConversation> {
  const token = await ctx.getAccessToken()
  const detail = await getAssistantConversation(ctx.serverUrl, token, conversationId)
  const decoded = await decodeCloudConversation(ctx, detail)
  const saved: LocalAssistantConversation = {
    key: `${ctx.accountId}::${detail.id}`,
    accountId: ctx.accountId,
    id: detail.id,
    title: decoded.title,
    updatedAt: detail.updated_at,
    hash: detail.hash,
    syncedHash: detail.hash,
    encrypted: decoded.encrypted,
    messages: decoded.messages,
    settings: decoded.settings,
  }
  await vault.saveAssistantConversation(saved)
  return saved
}

export async function removeConversationEverywhere(
  ctx: AssistantSyncContext,
  conversationId: string
): Promise<void> {
  await vault.deleteAssistantConversation(ctx.accountId, conversationId)
  const token = await ctx.getAccessToken()
  await deleteAssistantConversation(ctx.serverUrl, token, conversationId, ctx.deviceTabId)
}

/**
 * Full reconcile between local IndexedDB conversations and `GET /assistant/conversations`.
 * Returns updated local list + any active open-conversation conflict needing user choice.
 */
export async function reconcileAssistantConversations(
  ctx: AssistantSyncContext,
  options: { openConversationId: string | null; isOpenRunning?: boolean }
): Promise<{
  conversations: LocalAssistantConversation[]
  conflict: AssistantSyncConflict | null
}> {
  const token = await ctx.getAccessToken()
  const remote = await listAssistantConversations(ctx.serverUrl, token)
  const localList = await vault.listAssistantConversations(ctx.accountId)

  const localById = new Map(localList.map((c) => [c.id, c]))
  const cloudById = new Map(remote.conversations.map((c) => [c.id, c]))
  const allIds = new Set([...localById.keys(), ...cloudById.keys()])

  let conflict: AssistantSyncConflict | null = null
  const enc = ctx.getEncryption()

  for (const id of allIds) {
    const local = localById.get(id) ?? null
    const cloud = cloudById.get(id) ?? null

    // Skip encrypted cloud rows while key is still locked
    if (cloud?.encrypted && !enc.dek) continue

    const decision = resolveSyncDecision({
      localHash: local?.hash ?? null,
      syncedHash: local?.syncedHash ?? null,
      cloudHash: cloud?.hash ?? null,
      isOpen: id === options.openConversationId,
    })

    if (decision === "pull" && cloud) {
      if (id === options.openConversationId && options.isOpenRunning) continue
      await pullConversationFromCloud(ctx, id)
    } else if (decision === "push" && local) {
      if (enc.enabled && !enc.dek) continue
      await pushConversationToCloud(ctx, local)
    } else if (decision === "fork_local" && local && cloud) {
      // Auto-preserve both: fork local under a new id and accept cloud under original id.
      const forkedId = newConversationId()
      const forked: LocalAssistantConversation = {
        ...local,
        key: `${ctx.accountId}::${forkedId}`,
        id: forkedId,
        title: local.title.endsWith("（本机）") ? local.title : `${local.title}（本机）`,
        syncedHash: null,
        updatedAt: Date.now(),
      }
      await vault.saveAssistantConversation(forked)
      if (!enc.enabled || enc.dek) {
        await pushConversationToCloud(ctx, forked).catch(() => undefined)
      }
      await pullConversationFromCloud(ctx, id)
    } else if (decision === "conflict" && local && cloud && !conflict) {
      const detail = await getAssistantConversation(ctx.serverUrl, token, id)
      const decoded = await decodeCloudConversation(ctx, detail)
      conflict = {
        id,
        localTitle: local.title,
        cloudTitle: decoded.title,
        cloudHash: detail.hash,
        cloudUpdatedAt: detail.updated_at,
        cloudMessages: decoded.messages,
        cloudSettings: decoded.settings,
      }
    }
  }

  return {
    conversations: await vault.listAssistantConversations(ctx.accountId),
    conflict,
  }
}
