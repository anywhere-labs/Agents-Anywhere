"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import {
  deleteAssistantEncryption,
  fetchAssistantEncryption,
  putAssistantKeyEnvelope,
  resetAssistantEncryption,
  streamAssistantEvents,
} from "@/lib/api/control-http"
import {
  base64UrlToBytes,
  bytesToBase64Url,
  computeConversationHash,
  generateDek,
  unwrapDekWithPassword,
  wrapDekWithPassword,
} from "@/lib/assistant/crypto"
import {
  newConversationId,
  pullConversationFromCloud,
  pushConversationToCloud,
  reconcileAssistantConversations,
  removeConversationEverywhere,
  type AssistantSyncConflict,
  type AssistantSyncContext,
} from "@/lib/assistant/sync"
import {
  disconnectAccountTokens,
  fetchTokensModels,
  loadAccountTokens,
  pickDefaultTokensModel,
  type TokensModelItem,
} from "@/lib/assistant/tokens"
import { AssistantVfsManager, type VfsFileView } from "@/lib/assistant/vfs"
import { useWorkbench } from "@/lib/state/workbench-context"
import {
  vault,
  type AssistantModelPref,
  type LocalAssistantConversation,
} from "@/lib/storage/idb"
import type {
  AssistantKeyEnvelopeView,
  AssistantTokensView,
} from "@/lib/types/v3"

export interface PendingToolConfirm {
  id: string
  name: string
  args: Record<string, unknown>
  resolve: (allowed: boolean) => void
}

export interface AssistantChatEntry {
  role: "user" | "assistant" | "tool"
  text: string
  thinking?: string
  toolName?: string
  timestamp: number
}

export interface AssistantContextValue {
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  conversations: LocalAssistantConversation[]
  activeConversationId: string | null
  activeConversation: LocalAssistantConversation | null
  selectConversation: (id: string) => void
  startNewConversation: () => Promise<LocalAssistantConversation | null>
  deleteConversation: (id: string) => Promise<void>
  running: boolean
  streamingText: string
  streamingThinking: string
  sendMessage: (text: string) => Promise<void>
  stopRun: () => void
  // Sync & Conflict
  syncing: boolean
  syncNow: () => Promise<void>
  conflict: AssistantSyncConflict | null
  resolveConflictKeepLocal: () => Promise<void>
  resolveConflictUseCloud: () => Promise<void>
  // KEK/DEK Encryption
  encryptionEnabled: boolean
  envelope: AssistantKeyEnvelopeView | null
  encryptionUnlocked: boolean
  enableEncryption: (password: string) => Promise<void>
  unlockEncryption: (password: string) => Promise<void>
  lockEncryption: () => Promise<void>
  changeEncryptionPassword: (newPassword: string) => Promise<void>
  resetEncryption: (newPassword?: string) => Promise<{ wipedConversations: number; wipedDriveFiles: number }>
  disableEncryption: (confirmWipe: boolean) => Promise<void>
  // Tokens Anywhere & Models
  tokensStatus: AssistantTokensView | null
  tokensModels: TokensModelItem[]
  refreshTokens: () => Promise<void>
  disconnectTokens: () => Promise<void>
  activeModel: AssistantModelPref | null
  setActiveModel: (pref: AssistantModelPref) => Promise<void>
  // VFS
  vfsFiles: VfsFileView[]
  vfsSyncing: boolean
  refreshVfs: () => Promise<void>
  writeVfsFile: (path: string, content: string) => Promise<VfsFileView>
  readVfsFile: (path: string) => Promise<string>
  deleteVfsFile: (path: string) => Promise<void>
  syncVfsWithDrive: () => Promise<{ uploaded: number; downloaded: number; enabled: boolean }>
  // Tool confirmation modal
  pendingToolConfirm: PendingToolConfirm | null
  answerToolConfirm: (allowed: boolean) => void
}

const AssistantContext = createContext<AssistantContextValue | null>(null)

const DEFAULT_SYSTEM_PROMPT =
  "You are Agents Anywhere's Portable Assistant (Pi Lite). Be concise, helpful, and transparent when invoking Cloud VFS or MCP tools."

function extractMessageText(msg: Record<string, unknown>): {
  role: "user" | "assistant" | "tool"
  text: string
  thinking?: string
  toolName?: string
  timestamp: number
} | null {
  const role = msg.role
  const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now()
  if (role === "user") {
    const content = msg.content
    if (typeof content === "string") return { role: "user", text: content, timestamp: ts }
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
        .filter(Boolean)
        .join("\n")
      return { role: "user", text, timestamp: ts }
    }
  }
  if (role === "assistant") {
    const content = msg.content
    if (typeof content === "string") return { role: "assistant", text: content, timestamp: ts }
    if (Array.isArray(content)) {
      const texts: string[] = []
      const thinkings: string[] = []
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as Record<string, unknown>
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text)
        else if (b.type === "thinking" && typeof b.thinking === "string") thinkings.push(b.thinking)
      }
      return {
        role: "assistant",
        text: texts.join("\n"),
        thinking: thinkings.join("\n") || undefined,
        timestamp: ts,
      }
    }
  }
  if (role === "toolResult") {
    const content = msg.content
    const text = Array.isArray(content)
      ? content
          .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
          .filter(Boolean)
          .join("\n")
      : ""
    return {
      role: "tool",
      toolName: typeof msg.toolName === "string" ? msg.toolName : "tool",
      text,
      timestamp: ts,
    }
  }
  return null
}

export function extractChatEntries(messages: Record<string, unknown>[]): AssistantChatEntry[] {
  return messages
    .map(extractMessageText)
    .filter((item): item is NonNullable<typeof item> => item !== null)
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const {
    activeAccount,
    preferences,
    getFreshAccessToken,
    updatePreferences,
  } = useWorkbench()
  const { t } = useI18n()

  const [deviceTabIdValue] = useState(() => `tab_${Math.random().toString(36).slice(2, 10)}`)
  const deviceTabId = useRef(deviceTabIdValue)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [conversations, setConversations] = useState<LocalAssistantConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [streamingText, setStreamingText] = useState("")
  const [streamingThinking, setStreamingThinking] = useState("")
  const [syncing, setSyncing] = useState(false)
  const [conflict, setConflict] = useState<AssistantSyncConflict | null>(null)

  const [encryptionEnabled, setEncryptionEnabled] = useState(false)
  const [envelope, setEnvelope] = useState<AssistantKeyEnvelopeView | null>(null)
  const [dekBytes, setDekBytes] = useState<Uint8Array<ArrayBuffer> | null>(null)

  const [tokensStatus, setTokensStatus] = useState<AssistantTokensView | null>(null)
  const [tokensModels, setTokensModels] = useState<TokensModelItem[]>([])

  const [vfsFiles, setVfsFiles] = useState<VfsFileView[]>([])
  const [vfsSyncing, setVfsSyncing] = useState(false)
  const [pendingToolConfirm, setPendingToolConfirm] = useState<PendingToolConfirm | null>(null)

  const abortRunRef = useRef<AbortController | null>(null)
  const dekRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const envelopeRef = useRef<AssistantKeyEnvelopeView | null>(null)
  const encryptionEnabledRef = useRef(false)
  const activeConvIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    dekRef.current = dekBytes
  }, [dekBytes])
  useEffect(() => {
    envelopeRef.current = envelope
  }, [envelope])
  useEffect(() => {
    encryptionEnabledRef.current = encryptionEnabled
  }, [encryptionEnabled])
  useEffect(() => {
    activeConvIdRef.current = activeConversationId
  }, [activeConversationId])
  useEffect(() => {
    runningRef.current = running
  }, [running])

  // Global keyboard shortcut: Cmd/Ctrl + J toggles Quick Assistant Drawer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault()
        setDrawerOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const makeSyncCtx = useCallback((): AssistantSyncContext | null => {
    if (!activeAccount) return null
    return {
      accountId: activeAccount.accountId,
      userId: activeAccount.user.id,
      serverUrl: activeAccount.serverUrl,
      deviceTabId: deviceTabId.current,
      getAccessToken: getFreshAccessToken,
      getEncryption: () => ({
        enabled: encryptionEnabledRef.current,
        dek: dekRef.current,
        keyVersion: envelopeRef.current?.key_version ?? null,
        dekEpoch: envelopeRef.current?.dek_epoch ?? null,
      }),
    }
  }, [activeAccount, getFreshAccessToken])

  const makeVfs = useCallback((): AssistantVfsManager | null => {
    if (!activeAccount) return null
    return new AssistantVfsManager({
      accountId: activeAccount.accountId,
      userId: activeAccount.user.id,
      serverUrl: activeAccount.serverUrl,
      getAccessToken: getFreshAccessToken,
      getEncryptionContext: () => ({
        enabled: encryptionEnabledRef.current,
        dek: dekRef.current,
        keyVersion: envelopeRef.current?.key_version ?? null,
      }),
    })
  }, [activeAccount, getFreshAccessToken])

  const refreshVfs = useCallback(async () => {
    const vfs = makeVfs()
    if (!vfs) return
    setVfsFiles(await vfs.listFiles())
  }, [makeVfs])

  const refreshTokens = useCallback(async () => {
    if (!activeAccount) return
    try {
      const tok = await getFreshAccessToken()
      const status = await loadAccountTokens(activeAccount.serverUrl, tok)
      setTokensStatus(status)
      if (status.connected && status.key) {
        try {
          const models = await fetchTokensModels(status.tokens_url, status.key)
          setTokensModels(models)
          if (!preferences.assistantModel && models.length > 0) {
            const picked = pickDefaultTokensModel(models)
            if (picked) {
              await updatePreferences({
                assistantModel: {
                  source: "tokens",
                  format: picked.format,
                  baseUrl: picked.baseUrl,
                  model: picked.id,
                  modelName: picked.name,
                  thinking: "medium",
                  webSearch: false,
                },
              })
            }
          }
        } catch {
          setTokensModels([])
        }
      } else {
        setTokensModels([])
      }
    } catch {
      setTokensStatus(null)
    }
  }, [activeAccount, getFreshAccessToken, preferences.assistantModel, updatePreferences])

  const syncNow = useCallback(async () => {
    const ctx = makeSyncCtx()
    if (!ctx) return
    setSyncing(true)
    try {
      const res = await reconcileAssistantConversations(ctx, {
        openConversationId: activeConvIdRef.current,
        isOpenRunning: runningRef.current,
      })
      setConversations(res.conversations)
      if (res.conflict) setConflict(res.conflict)
    } finally {
      setSyncing(false)
    }
  }, [makeSyncCtx])

  // Hydrate account assistant data + SSE cross-device stream
  const activeAccountId = activeAccount?.accountId ?? null
  useEffect(() => {
    const abort = new AbortController()
    const acct = activeAccount
    if (!acct) {
      queueMicrotask(() => {
        if (abort.signal.aborted) return
        setConversations([])
        setActiveConversationId(null)
        setEnvelope(null)
        setEncryptionEnabled(false)
        setDekBytes(null)
        setTokensStatus(null)
        setTokensModels([])
        setVfsFiles([])
      })
      return () => {
        abort.abort()
      }
    }

    ;(async () => {
      const [localConvs, cachedDek] = await Promise.all([
        vault.listAssistantConversations(acct.accountId),
        vault.getCachedAssistantDek(acct.accountId),
      ])
      if (abort.signal.aborted) return
      setConversations(localConvs)
      setActiveConversationId((prev) => prev ?? localConvs[0]?.id ?? null)

      const vfs = makeVfs()
      if (vfs) setVfsFiles(await vfs.listFiles())

      try {
        const token = await getFreshAccessToken()
        const enc = await fetchAssistantEncryption(acct.serverUrl, token)
        if (abort.signal.aborted) return
        setEncryptionEnabled(enc.enabled)
        encryptionEnabledRef.current = enc.enabled
        setEnvelope(enc.envelope)
        envelopeRef.current = enc.envelope

        if (enc.enabled && enc.envelope && cachedDek) {
          if (cachedDek.dekEpoch === enc.envelope.dek_epoch) {
            const rawDek = base64UrlToBytes(cachedDek.dekB64)
            setDekBytes(rawDek)
            dekRef.current = rawDek
          } else {
            await vault.clearCachedAssistantDek(acct.accountId)
            setDekBytes(null)
            dekRef.current = null
          }
        } else {
          setDekBytes(null)
          dekRef.current = null
        }

        await refreshTokens()
        await syncNow()
      } catch {
        // Offline or server unreachable; local IndexedDB conversations remain usable.
      }

      // Live SSE stream from server-v3 Redis Pub/Sub
      while (!abort.signal.aborted) {
        try {
          const token = await getFreshAccessToken()
          await streamAssistantEvents(
            acct.serverUrl,
            token,
            (msg) => {
              if (msg.event === "assistant") {
                if (msg.data.device === deviceTabId.current) return
                void syncNow()
              } else if (msg.event === "assistant_encryption") {
                if (msg.data.reset) {
                  void vault.clearCachedAssistantDek(acct.accountId)
                  setDekBytes(null)
                  dekRef.current = null
                }
                void (async () => {
                  const t = await getFreshAccessToken()
                  const fresh = await fetchAssistantEncryption(acct.serverUrl, t)
                  setEncryptionEnabled(fresh.enabled)
                  encryptionEnabledRef.current = fresh.enabled
                  setEnvelope(fresh.envelope)
                  envelopeRef.current = fresh.envelope
                })()
              } else if (msg.event === "assistant_tokens") {
                void refreshTokens()
              }
            },
            abort.signal
          )
        } catch {
          if (abort.signal.aborted) break
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    })()

    return () => {
      abort.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId, getFreshAccessToken, makeVfs, refreshTokens, syncNow])

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  )

  const selectConversation = useCallback((id: string) => {
    setActiveConversationId(id)
  }, [])

  const startNewConversation = useCallback(async () => {
    if (!activeAccount) return null
    const id = newConversationId()
    const hash = await computeConversationHash("New chat", [], null)
    const created: LocalAssistantConversation = {
      key: `${activeAccount.accountId}::${id}`,
      accountId: activeAccount.accountId,
      id,
      title: "New chat",
      updatedAt: Date.now(),
      hash,
      syncedHash: null,
      encrypted: encryptionEnabledRef.current,
      messages: [],
      settings: null,
    }
    await vault.saveAssistantConversation(created)
    setConversations((prev) => [created, ...prev])
    setActiveConversationId(id)
    return created
  }, [activeAccount])

  const deleteConversation = useCallback(
    async (id: string) => {
      const ctx = makeSyncCtx()
      if (!ctx) return
      await removeConversationEverywhere(ctx, id).catch(() =>
        vault.deleteAssistantConversation(ctx.accountId, id)
      )
      setConversations((prev) => prev.filter((c) => c.id !== id))
      setActiveConversationId((prev) => (prev === id ? null : prev))
    },
    [makeSyncCtx]
  )

  const answerToolConfirm = useCallback(
    (allowed: boolean) => {
      if (!pendingToolConfirm) return
      pendingToolConfirm.resolve(allowed)
      setPendingToolConfirm(null)
    },
    [pendingToolConfirm]
  )

  const stopRun = useCallback(() => {
    abortRunRef.current?.abort()
    abortRunRef.current = null
    setRunning(false)
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !activeAccount || runningRef.current) return

      const modelPref = preferences.assistantModel
      const apiKey =
        modelPref?.source === "tokens" ? tokensStatus?.key ?? "" : modelPref?.apiKey ?? ""
      if (!modelPref || !apiKey) {
        throw new Error("Configure Tokens Anywhere or a local BYOK API key first")
      }

      let conv = activeConversation
      if (!conv) {
        conv = await startNewConversation()
        if (!conv) return
      }

      const title =
        conv.messages.length === 0 ? trimmed.slice(0, 60) : conv.title
      const userMsg: Record<string, unknown> = {
        role: "user",
        content: [{ type: "text", text: trimmed }],
        timestamp: Date.now(),
      }
      const nextMessages = [...conv.messages, userMsg]
      const draftHash = await computeConversationHash(title, nextMessages, conv.settings)
      const optimistic: LocalAssistantConversation = {
        ...conv,
        title,
        updatedAt: Date.now(),
        hash: draftHash,
        messages: nextMessages,
      }
      await vault.saveAssistantConversation(optimistic)
      setConversations((prev) => [optimistic, ...prev.filter((c) => c.id !== optimistic.id)])

      setRunning(true)
      setStreamingText("")
      setStreamingThinking("")
      const abort = new AbortController()
      abortRunRef.current = abort

      try {
        // Dynamically lazy-load Pi Lite runtime only when actually chatting!
        const { createPiLiteAgent } = await import("@/lib/assistant/runtime")
        const vfs = makeVfs() ?? undefined
        const { agent, mcpErrors } = await createPiLiteAgent({
          choice: {
            format: modelPref.format,
            baseUrl: modelPref.baseUrl,
            model: modelPref.model,
            apiKey,
            name: modelPref.modelName,
            thinking: modelPref.thinking,
            webSearch: modelPref.webSearch,
          },
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          messages: conv.messages as never,
          vfs,
          mcpServers: preferences.assistantMcpServers,
          experimental: { jsExecution: preferences.assistantExperimental.jsExecution },
          onWorkspaceChanged: () => void refreshVfs(),
          confirm: (call) =>
            new Promise<boolean>((resolve) => {
              setPendingToolConfirm({ ...call, resolve })
            }),
        })
        for (const failure of mcpErrors) {
          toast.warning(t("assistant.mcpUnavailable", { name: failure.server, message: failure.message }))
        }

        let accText = ""
        let accThinking = ""
        agent.subscribe((ev) => {
          if (ev.type === "message_update" && "assistantMessageEvent" in ev) {
            const ame = (ev as { assistantMessageEvent: { type: string; delta?: string } })
              .assistantMessageEvent
            if (ame.type === "text_delta" && ame.delta) {
              accText += ame.delta
              setStreamingText(accText)
            } else if (ame.type === "thinking_delta" && ame.delta) {
              accThinking += ame.delta
              setStreamingThinking(accThinking)
            }
          }
        })

        abort.signal.addEventListener("abort", () => agent.abort(), { once: true })
        await agent.prompt(trimmed)

        const finalMessages = (agent.state.messages as unknown as Record<string, unknown>[]) ?? nextMessages
        const finalHash = await computeConversationHash(title, finalMessages, {
          model: modelPref.model,
          format: modelPref.format,
          thinking: modelPref.thinking,
        })
        const completed: LocalAssistantConversation = {
          ...optimistic,
          updatedAt: Date.now(),
          hash: finalHash,
          messages: finalMessages,
          settings: {
            model: modelPref.model,
            format: modelPref.format,
            thinking: modelPref.thinking,
          },
        }
        await vault.saveAssistantConversation(completed)
        setConversations((prev) => [completed, ...prev.filter((c) => c.id !== completed.id)])
        await refreshVfs()

        const syncCtx = makeSyncCtx()
        if (syncCtx && (!encryptionEnabledRef.current || dekRef.current)) {
          const synced = await pushConversationToCloud(syncCtx, completed)
          setConversations((prev) => [synced, ...prev.filter((c) => c.id !== synced.id)])
        }
      } finally {
        abortRunRef.current = null
        setRunning(false)
        setStreamingText("")
        setStreamingThinking("")
      }
    },
    [
      activeAccount,
      activeConversation,
      makeSyncCtx,
      makeVfs,
      preferences.assistantExperimental.jsExecution,
      preferences.assistantMcpServers,
      preferences.assistantModel,
      refreshVfs,
      startNewConversation,
      t,
      tokensStatus?.key,
    ]
  )

  const resolveConflictKeepLocal = useCallback(async () => {
    const ctx = makeSyncCtx()
    if (!ctx || !conflict) return
    const local = await vault.getAssistantConversation(ctx.accountId, conflict.id)
    if (local) {
      const copyId = newConversationId()
      const copy: LocalAssistantConversation = {
        ...local,
        key: `${ctx.accountId}::${copyId}`,
        id: copyId,
        title: `${local.title}（本机）`,
        syncedHash: null,
        updatedAt: Date.now(),
      }
      await vault.saveAssistantConversation(copy)
      await pushConversationToCloud(ctx, copy).catch(() => undefined)
    }
    await pullConversationFromCloud(ctx, conflict.id)
    setConflict(null)
    setConversations(await vault.listAssistantConversations(ctx.accountId))
  }, [conflict, makeSyncCtx])

  const resolveConflictUseCloud = useCallback(async () => {
    const ctx = makeSyncCtx()
    if (!ctx || !conflict) return
    await pullConversationFromCloud(ctx, conflict.id)
    setConflict(null)
    setConversations(await vault.listAssistantConversations(ctx.accountId))
  }, [conflict, makeSyncCtx])

  // ── KEK/DEK Encryption Actions ──

  const enableEncryption = useCallback(
    async (password: string) => {
      if (!activeAccount) return
      const token = await getFreshAccessToken()
      const dek = generateDek()
      const wrapped = await wrapDekWithPassword(password, dek)
      const res = await putAssistantKeyEnvelope(activeAccount.serverUrl, token, {
        ...wrapped,
        expected_version: 0,
        device: deviceTabId.current,
      })
      setEncryptionEnabled(res.enabled)
      encryptionEnabledRef.current = res.enabled
      setEnvelope(res.envelope)
      envelopeRef.current = res.envelope
      setDekBytes(dek)
      dekRef.current = dek
      if (res.envelope) {
        await vault.saveCachedAssistantDek({
          accountId: activeAccount.accountId,
          dekB64: bytesToBase64Url(dek),
          keyVersion: res.envelope.key_version,
          dekEpoch: res.envelope.dek_epoch,
          unlockedAt: new Date().toISOString(),
        })
      }
      await syncNow()
    },
    [activeAccount, getFreshAccessToken, syncNow]
  )

  const unlockEncryption = useCallback(
    async (password: string) => {
      if (!activeAccount || !envelopeRef.current) return
      const dek = await unwrapDekWithPassword(password, envelopeRef.current)
      setDekBytes(dek)
      dekRef.current = dek
      await vault.saveCachedAssistantDek({
        accountId: activeAccount.accountId,
        dekB64: bytesToBase64Url(dek),
        keyVersion: envelopeRef.current.key_version,
        dekEpoch: envelopeRef.current.dek_epoch,
        unlockedAt: new Date().toISOString(),
      })
      await syncNow()
    },
    [activeAccount, syncNow]
  )

  const lockEncryption = useCallback(async () => {
    if (!activeAccount) return
    await vault.clearCachedAssistantDek(activeAccount.accountId)
    setDekBytes(null)
    dekRef.current = null
  }, [activeAccount])

  const changeEncryptionPassword = useCallback(
    async (newPassword: string) => {
      if (!activeAccount || !dekRef.current || !envelopeRef.current) {
        throw new Error("Unlock your current encryption key before changing the password")
      }
      const token = await getFreshAccessToken()
      const wrapped = await wrapDekWithPassword(newPassword, dekRef.current)
      const res = await putAssistantKeyEnvelope(activeAccount.serverUrl, token, {
        ...wrapped,
        expected_version: envelopeRef.current.key_version,
        device: deviceTabId.current,
      })
      setEnvelope(res.envelope)
      envelopeRef.current = res.envelope
      if (res.envelope) {
        await vault.saveCachedAssistantDek({
          accountId: activeAccount.accountId,
          dekB64: bytesToBase64Url(dekRef.current),
          keyVersion: res.envelope.key_version,
          dekEpoch: res.envelope.dek_epoch,
          unlockedAt: new Date().toISOString(),
        })
      }
    },
    [activeAccount, getFreshAccessToken]
  )

  const resetEncryption = useCallback(
    async (newPassword?: string) => {
      if (!activeAccount) return { wipedConversations: 0, wipedDriveFiles: 0 }
      const token = await getFreshAccessToken()
      let newDek: Uint8Array<ArrayBuffer> | null = null
      let wrapped: Awaited<ReturnType<typeof wrapDekWithPassword>> | null = null
      if (newPassword) {
        newDek = generateDek()
        wrapped = await wrapDekWithPassword(newPassword, newDek)
      }
      const res = await resetAssistantEncryption(activeAccount.serverUrl, token, {
        confirm_wipe: true,
        new_envelope: wrapped,
        wipe_drive_vfs: true,
        device: deviceTabId.current,
      })
      await vault.clearEncryptedAssistantConversations(activeAccount.accountId)
      setEncryptionEnabled(res.enabled)
      encryptionEnabledRef.current = res.enabled
      setEnvelope(res.envelope)
      envelopeRef.current = res.envelope
      if (newDek && res.envelope) {
        setDekBytes(newDek)
        dekRef.current = newDek
        await vault.saveCachedAssistantDek({
          accountId: activeAccount.accountId,
          dekB64: bytesToBase64Url(newDek),
          keyVersion: res.envelope.key_version,
          dekEpoch: res.envelope.dek_epoch,
          unlockedAt: new Date().toISOString(),
        })
      } else {
        await vault.clearCachedAssistantDek(activeAccount.accountId)
        setDekBytes(null)
        dekRef.current = null
      }
      setConversations(await vault.listAssistantConversations(activeAccount.accountId))
      await refreshVfs()
      return {
        wipedConversations: res.wiped_conversations,
        wipedDriveFiles: res.wiped_drive_files,
      }
    },
    [activeAccount, getFreshAccessToken, refreshVfs]
  )

  const disableEncryption = useCallback(
    async (confirmWipe: boolean) => {
      if (!activeAccount) return
      const token = await getFreshAccessToken()
      await deleteAssistantEncryption(activeAccount.serverUrl, token, confirmWipe)
      await vault.clearCachedAssistantDek(activeAccount.accountId)
      if (confirmWipe) await vault.clearEncryptedAssistantConversations(activeAccount.accountId)
      setEncryptionEnabled(false)
      encryptionEnabledRef.current = false
      setEnvelope(null)
      envelopeRef.current = null
      setDekBytes(null)
      dekRef.current = null
      setConversations(await vault.listAssistantConversations(activeAccount.accountId))
    },
    [activeAccount, getFreshAccessToken]
  )

  const disconnectTokens = useCallback(async () => {
    if (!activeAccount) return
    const token = await getFreshAccessToken()
    await disconnectAccountTokens(activeAccount.serverUrl, token)
    await refreshTokens()
  }, [activeAccount, getFreshAccessToken, refreshTokens])

  const setActiveModel = useCallback(
    async (pref: AssistantModelPref) => {
      await updatePreferences({ assistantModel: pref })
    },
    [updatePreferences]
  )

  const writeVfsFile = useCallback(
    async (path: string, content: string) => {
      const vfs = makeVfs()
      if (!vfs) throw new Error("Not signed in")
      const saved = await vfs.writeText(path, content)
      await refreshVfs()
      return saved
    },
    [makeVfs, refreshVfs]
  )

  const readVfsFile = useCallback(
    async (path: string) => {
      const vfs = makeVfs()
      if (!vfs) throw new Error("Not signed in")
      return vfs.readText(path)
    },
    [makeVfs]
  )

  const deleteVfsFile = useCallback(
    async (path: string) => {
      const vfs = makeVfs()
      if (!vfs) return
      await vfs.deleteFile(path)
      await refreshVfs()
    },
    [makeVfs, refreshVfs]
  )

  const syncVfsWithDrive = useCallback(async () => {
    const vfs = makeVfs()
    if (!vfs) return { uploaded: 0, downloaded: 0, enabled: false }
    setVfsSyncing(true)
    try {
      const res = await vfs.syncWithCloudDrive()
      await refreshVfs()
      return res
    } finally {
      setVfsSyncing(false)
    }
  }, [makeVfs, refreshVfs])

  const value = useMemo<AssistantContextValue>(
    () => ({
      drawerOpen,
      setDrawerOpen,
      conversations,
      activeConversationId,
      activeConversation,
      selectConversation,
      startNewConversation,
      deleteConversation,
      running,
      streamingText,
      streamingThinking,
      sendMessage,
      stopRun,
      syncing,
      syncNow,
      conflict,
      resolveConflictKeepLocal,
      resolveConflictUseCloud,
      encryptionEnabled,
      envelope,
      encryptionUnlocked: !encryptionEnabled || dekBytes !== null,
      enableEncryption,
      unlockEncryption,
      lockEncryption,
      changeEncryptionPassword,
      resetEncryption,
      disableEncryption,
      tokensStatus,
      tokensModels,
      refreshTokens,
      disconnectTokens,
      activeModel: preferences.assistantModel ?? null,
      setActiveModel,
      vfsFiles,
      vfsSyncing,
      refreshVfs,
      writeVfsFile,
      readVfsFile,
      deleteVfsFile,
      syncVfsWithDrive,
      pendingToolConfirm,
      answerToolConfirm,
    }),
    [
      drawerOpen,
      conversations,
      activeConversationId,
      activeConversation,
      selectConversation,
      startNewConversation,
      deleteConversation,
      running,
      streamingText,
      streamingThinking,
      sendMessage,
      stopRun,
      syncing,
      syncNow,
      conflict,
      resolveConflictKeepLocal,
      resolveConflictUseCloud,
      encryptionEnabled,
      envelope,
      dekBytes,
      enableEncryption,
      unlockEncryption,
      lockEncryption,
      changeEncryptionPassword,
      resetEncryption,
      disableEncryption,
      tokensStatus,
      tokensModels,
      refreshTokens,
      disconnectTokens,
      preferences.assistantModel,
      setActiveModel,
      vfsFiles,
      vfsSyncing,
      refreshVfs,
      writeVfsFile,
      readVfsFile,
      deleteVfsFile,
      syncVfsWithDrive,
      pendingToolConfirm,
      answerToolConfirm,
    ]
  )

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext)
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider")
  return ctx
}
