"use client"

import * as React from "react"
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
  userId: string | null
  token: string | null
  addMessage: (message: OptimisticSessionMessage) => void
  bind: (localId: string, session: SessionView, attachments?: AttachmentRef[]) => void
  markFailed: (id: string, message: string) => void
  removeLocal: (id: string) => void
  open: (id: string) => void
  edit: (projectId: string) => void
}

/** Workspace-owned requests survive composer unmounts and never retry automatically. */
export function useSessionCreation(options: Options) {
  const latest = React.useRef(options)
  latest.current = options
  const [creations, setCreations] = React.useState<Record<string, SessionCreation>>({})
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
  }, [options.userId])

  React.useEffect(() => {
    setCreations({})
    setEditorDraft(null)
  }, [options.userId])

  const returnToEditor = React.useCallback((id: string) => {
    const entry = entries.current[id]
    if (!entry || entry.status !== "failed" || entry.resultUnknown) return
    if (editor.current) releaseCreationAttachments(editor.current.attachments)
    editor.current = entry.draft
    setEditorDraft(entry.draft)
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
    try {
      if (retry) await validateCreationRetry(token, entry.draft.request)
      if (version !== generation.current || userId !== latest.current.userId) return
      const attachments = await inlineAttachmentsFromFiles(entry.draft.attachments)
      if (version !== generation.current || userId !== latest.current.userId) return
      requestSent = true
      const created = await dashboardApi.createAndStartSession(token, {
        ...entry.draft.request,
        ...(attachments.length ? { attachments } : {}),
      })
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
      const failure = creationFailure(error, requestSent)
      const configurationRequired = isApiError(error) && error.code === "creation_configuration_required"
      entries.current[id] = { draft: { ...entry.draft, configurationRequired }, status: "failed", ...failure }
      latest.current.markFailed(entry.draft.clientMessageId, failure.message ?? "")
      publish()
      if (configurationRequired) returnToEditor(id)
    } finally {
      if (version === generation.current) inFlight.current.delete(id)
    }
  }, [publish, returnToEditor])

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

  return { sessionCreations: creations, creationEditorDraft: editorDraft,
    startSessionCreation: start, retrySessionCreation: retry,
    editSessionCreation: returnToEditor, discardCreationEditor: discardEditor, saveCreationEditor: saveEditor }
}
