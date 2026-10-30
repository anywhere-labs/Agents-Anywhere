"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { apiClient } from "@/lib/api"
import { workflowApi, type WorkflowView, type WorkflowInteraction, type RuntimeDialogValue } from "@/features/dashboard/runtime-workflows"
import { isApiError } from "@/lib/api/errors"
import { validateCreationRetry } from "./creation-configuration"
import { dashboardApi } from "@/features/dashboard/api"
import type { AttachmentRef, SessionView } from "@/features/dashboard/types"
import type { OptimisticSessionMessage } from "@/components/workspace-context"
import {
  copyCreationAttachments, creationFailure, inlineAttachmentsFromFiles, releaseCreationAttachments,
  type SessionCreation, type SessionCreationDraft,
} from "./session-creation"

type Options = {
  storageScope: string
  userId: string | null
  token: string | null
  addMessage: (message: OptimisticSessionMessage) => void
  bind: (localId: string, session: SessionView, attachments?: AttachmentRef[]) => void
  markFailed: (id: string, message: string) => void
  removeLocal: (id: string) => void
  open: (id: string) => void
  edit: (projectId: string) => void
}

function storedOperationIds(scope: string): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem("aa.runtime.creations:" + scope) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length <= 160).slice(-32) : [] } catch { return [] }
}
function rememberOperation(scope: string, id: string, remove = false) {
  try { const values = storedOperationIds(scope).filter(value => value !== id); if (!remove) values.push(id); localStorage.setItem("aa.runtime.creations:" + scope, JSON.stringify(values.slice(-32))) } catch { /* Storage restrictions do not authorize resending. */ }
}

/** Workspace-owned requests survive composer unmounts and never retry automatically. */
export function useSessionCreation(options: Options) {
  const tCreation = useTranslations("dashboard.new")
  const latest = React.useRef(options)
  latest.current = options
  const [creations, setCreations] = React.useState<Record<string, SessionCreation>>({})
  const [workflowCreations, setWorkflowCreations] = React.useState<Record<string, WorkflowView>>({})
  const [workflowError, setWorkflowError] = React.useState<string>()
  const [workflowPending, setWorkflowPending] = React.useState(false)
  const [editorDraft, setEditorDraft] = React.useState<SessionCreationDraft | null>(null)
  const entries = React.useRef<Record<string, SessionCreation>>({})
  const editor = React.useRef<SessionCreationDraft | null>(null)
  const inFlight = React.useRef(new Set<string>())
  const bindings = React.useRef(new Map<string, (id: string) => void>())
  const generation = React.useRef(0)
  const messages = React.useRef(new Map<string, OptimisticSessionMessage>())
  const publish = React.useCallback(() => setCreations({ ...entries.current }), [])

  React.useEffect(() => {
    const current = ++generation.current
    return () => {
      if (generation.current !== current) return
      ++generation.current
      for (const [id, entry] of Object.entries(entries.current)) {
        releaseCreationAttachments(entry.draft.attachments)
        latest.current.removeLocal(id)
      }
      if (editor.current) releaseCreationAttachments(editor.current.attachments)
      entries.current = {}
      editor.current = null
      inFlight.current.clear()
      bindings.current.clear()
      messages.current.clear()
    }
  }, [options.userId, options.storageScope])

  React.useEffect(() => {
    setCreations({})
    setWorkflowCreations({})
    setWorkflowError(undefined)
    setWorkflowPending(false)
    setEditorDraft(null)
  }, [options.userId, options.storageScope])

  const returnToEditor = React.useCallback((id: string) => {
    const entry = entries.current[id]
    if (!entry || entry.status !== "failed" || entry.resultUnknown) return
    if (editor.current) releaseCreationAttachments(editor.current.attachments)
    editor.current = { ...entry.draft, preparedWorkspace: undefined }
    setEditorDraft(editor.current)
    delete entries.current[id]
    bindings.current.delete(id)
    messages.current.delete(id)
    latest.current.removeLocal(id)
    publish()
    latest.current.edit(entry.draft.request.projectId)
  }, [publish])

  const submit = React.useCallback(async (id: string, retry = false) => {
    const entry = entries.current[id]
    const token = latest.current.token
    if (!entry || !token || inFlight.current.has(id)) return
    inFlight.current.add(id)
    const version = generation.current
    const userId = latest.current.userId
    entries.current[id] = { draft: entry.draft, status: "creating" }
    const message = messages.current.get(id)
    if (message) latest.current.addMessage(message)
    publish()
    let requestSent = false
    let workflowRefused = false
    try {
      if (retry) await validateCreationRetry(token, entry.draft.request)
      if (version !== generation.current || userId !== latest.current.userId) return
      const attachments = await inlineAttachmentsFromFiles(entry.draft.attachments)
      if (version !== generation.current || userId !== latest.current.userId) return
      requestSent = true
      let created
      if (entry.draft.preparedWorkspace) {
        const request = entry.draft.request
        rememberOperation(latest.current.storageScope, id)
        let operation = await workflowApi.begin(token, { ...entry.draft.preparedWorkspace,
          createOperationId: id, clientMessageId: entry.draft.clientMessageId,
          content: request.content, selections: request.selections ?? {}, ...(attachments.length ? { attachments } : {}), ...(request.title ? { title: request.title } : {}),
        })
        while (version === generation.current && userId === latest.current.userId) {
          setWorkflowCreations(current => ({ ...current, [id]: operation }))
          if (operation.state.messageAccepted === true) break
          if (["failed", "cancelled", "rejected", "outcome_unknown"].includes(operation.state.phase)) {
            workflowRefused = operation.state.messageAccepted === false
            if (workflowRefused) rememberOperation(latest.current.storageScope, id, true)
            throw new Error(operation.state.failure?.message ?? tCreation("createFailed"))
          }
          await new Promise(resolve => window.setTimeout(resolve, 1000))
          operation = await workflowApi.get(token, "creation", operation.id)
        }
        if (version !== generation.current || userId !== latest.current.userId) return
        if (!operation.sessionId) throw new Error(tCreation("createFailed"))
        created = await apiClient.get<{ session: SessionView; attachments?: AttachmentRef[] }>(`/sessions/${encodeURIComponent(operation.sessionId)}/meta`, { token })
        rememberOperation(latest.current.storageScope, id, true)
        setWorkflowCreations(current => { const next = { ...current }; delete next[id]; return next })
      } else {
        created = await dashboardApi.createAndStartSession(token, { ...entry.draft.request, ...(attachments.length ? { attachments } : {}) })
      }
      if (version !== generation.current || userId !== latest.current.userId) return
      bindings.current.get(id)?.(created.session.id)
      latest.current.bind(id, created.session, created.attachments)
      // The canonical response now owns the timeline's persisted attachment URLs.
      releaseCreationAttachments(entry.draft.attachments)
      delete entries.current[id]
      bindings.current.delete(id)
      messages.current.delete(id)
      publish()
    } catch (error) {
      if (version !== generation.current || userId !== latest.current.userId) return
      const failure = { ...creationFailure(error, requestSent), ...(workflowRefused ? { resultUnknown: false } : {}) }
      const configurationRequired = isApiError(error) && error.code === "creation_configuration_required"
      entries.current[id] = { draft: { ...entry.draft, configurationRequired }, status: "failed", ...failure }
      latest.current.markFailed(entry.draft.clientMessageId, failure.message ?? "")
      publish()
      if (configurationRequired) returnToEditor(id)
    } finally {
      if (version === generation.current) inFlight.current.delete(id)
    }
  }, [publish, returnToEditor, tCreation])

  const start = React.useCallback((draft: SessionCreationDraft, message: OptimisticSessionMessage, onBound: (id: string) => void) => {
    if (entries.current[draft.localSessionId]) return
    if (editor.current) releaseCreationAttachments(editor.current.attachments)
    editor.current = null
    setEditorDraft(null)
    entries.current[draft.localSessionId] = { draft, status: "creating" }
    bindings.current.set(draft.localSessionId, onBound)
    messages.current.set(draft.localSessionId, message)
    latest.current.open(draft.localSessionId)
    void submit(draft.localSessionId)
  }, [submit])

  const retry = React.useCallback((id: string) => {
    const entry = entries.current[id]
    if (entry?.status === "failed" && entry.retryable) void submit(id, true)
  }, [submit])

  const saveEditor = React.useCallback((draft: SessionCreationDraft) => {
    if (editor.current?.localSessionId !== draft.localSessionId) return
    const attachments = copyCreationAttachments(draft.attachments)
    releaseCreationAttachments(editor.current.attachments)
    editor.current = { ...draft, attachments }
    setEditorDraft(editor.current)
  }, [])

  const discardEditor = React.useCallback(() => {
    if (editor.current) releaseCreationAttachments(editor.current.attachments)
    editor.current = null
    setEditorDraft(null)
  }, [])

  const workflowScope = () => {
    const { token, userId, storageScope } = latest.current
    const version = generation.current
    return { token, isCurrent: () => version === generation.current && userId === latest.current.userId && storageScope === latest.current.storageScope }
  }
  const respondWorkflow = async (operation: WorkflowView, request: WorkflowInteraction, actionId: string, input?: RuntimeDialogValue) => {
    const { token, isCurrent } = workflowScope()
    if (!token || workflowPending) return
    setWorkflowPending(true)
    try { await workflowApi.respond(token, operation, request, actionId, input); if (isCurrent()) setWorkflowError(undefined) }
    catch (error) { if (isCurrent()) setWorkflowError(String(error)) }
    finally { if (isCurrent()) setWorkflowPending(false) }
  }
  const cancelWorkflow = async (operation: WorkflowView) => {
    const { token, isCurrent } = workflowScope()
    if (!token || workflowPending) return
    setWorkflowPending(true)
    try { const value = await workflowApi.cancel(token, operation); if (isCurrent()) { setWorkflowCreations(current => ({ ...current, [operation.id]: value })); setWorkflowError(undefined) } }
    catch (error) { if (isCurrent()) setWorkflowError(String(error)) }
    finally { if (isCurrent()) setWorkflowPending(false) }
  }
  const dismissWorkflow = (id: string) => setWorkflowCreations(current => { const next = { ...current }; delete next[id]; return next })
  const refreshWorkflow = async (operation: WorkflowView) => {
    const { token, isCurrent } = workflowScope()
    if (!token || workflowPending) return
    setWorkflowPending(true)
    try {
      const value = await workflowApi.get(token, "creation", operation.id)
      if (!isCurrent()) return
      setWorkflowCreations(current => ({ ...current, [operation.id]: value })); setWorkflowError(undefined)
      if (value.state.messageAccepted === true && value.sessionId) {
        const response = await apiClient.get<{ session: SessionView }>(`/sessions/${encodeURIComponent(value.sessionId)}/meta`, { token })
        if (!isCurrent()) return
        bindings.current.get(operation.id)?.(response.session.id)
        latest.current.bind(operation.id, response.session)
        const entry = entries.current[operation.id]
        if (entry) releaseCreationAttachments(entry.draft.attachments)
        delete entries.current[operation.id]; bindings.current.delete(operation.id); messages.current.delete(operation.id)
        rememberOperation(latest.current.storageScope, operation.id, true)
        dismissWorkflow(operation.id); publish()
      }
    } catch (error) { if (isCurrent()) setWorkflowError(String(error)) }
    finally { if (isCurrent()) setWorkflowPending(false) }
  }
  React.useEffect(() => {
    if (!options.userId || !options.token) return
    let cancelled = false
    for (const id of storedOperationIds(options.storageScope)) {
      const placeholder: WorkflowView = { protocolVersion: "1.1", id, kind: "creation", connectorId: "", runtimeId: "", projectId: "",
        state: { phase: "outcome_unknown", revision: 0, interactions: [] } }
      setWorkflowCreations(current => ({ ...current, [id]: placeholder }))
      void workflowApi.get(options.token, "creation", id).then(value => {
        if (!cancelled) setWorkflowCreations(current => ({ ...current, [id]: value }))
      }).catch(error => { if (!cancelled) setWorkflowError(String(error)) })
    }
    return () => { cancelled = true }
  }, [options.storageScope, options.userId])
  const workflowKey = Object.keys(workflowCreations).sort().join("|")
  React.useEffect(() => {
    const token = latest.current.token
    if (!token || !workflowKey) return
    let cancelled = false, querying = false
    const version = generation.current
    const timer = window.setInterval(async () => {
      if (querying) return
      querying = true
      try {
        for (const id of workflowKey.split("|")) {
          if (inFlight.current.has(id)) continue
          const value = await workflowApi.get(token, "creation", id)
          if (cancelled || version !== generation.current) return
          setWorkflowCreations(current => ({ ...current, [id]: value }))
          if (value.state.messageAccepted === true) await refreshWorkflow(value)
        }
      } catch (error) { if (!cancelled && version === generation.current) setWorkflowError(String(error)) }
      finally { querying = false }
    }, 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [workflowKey, options.storageScope, options.userId])
  return { refreshWorkflow, dismissWorkflow, workflowCreations, workflowError, workflowPending, respondWorkflow, cancelWorkflow, sessionCreations: creations, creationEditorDraft: editorDraft,
    startSessionCreation: start, retrySessionCreation: retry,
    editSessionCreation: returnToEditor, discardCreationEditor: discardEditor, saveCreationEditor: saveEditor }
}
