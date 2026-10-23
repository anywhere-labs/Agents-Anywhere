import type { AttachedFile } from "@/components/attachment-input"
import type { WorkspaceSelection } from "@/components/workspace-picker"
import type { InlineAttachmentRef, SessionCreateAndStartRequest } from "@/features/dashboard/types"
import { isApiError } from "@/lib/api/errors"

/** A new-session draft remains local; File objects must never go into storage. */
export type SessionCreationDraft = {
  localSessionId: string
  clientMessageId: string
  prompt: string
  attachments: AttachedFile[]
  workspace: WorkspaceSelection
  modelId: string
  reasoningId: string
  permissionMode: string
  configurationRequired?: boolean
  request: Omit<SessionCreateAndStartRequest, "attachments">
}

export type SessionCreation = {
  draft: SessionCreationDraft
  status: "creating" | "failed"
  message?: string
  retryable?: boolean
  resultUnknown?: boolean
  serverSessionId?: string
}

/** Only the pre-create runtime rejection is safe to submit again without reconciliation. */
export function creationFailure(error: unknown, requestSent: boolean) {
  const payload = isApiError(error) ? error.payload as { detail?: { retryable?: unknown; phase?: { message?: unknown }; resultUnknown?: unknown; platformSessionCreated?: unknown; created?: unknown; messageAccepted?: unknown; sessionId?: unknown } } | undefined : undefined
  const retryable = isApiError(error) && error.status === 409 && error.code === "runtime_starting"
    && payload?.detail?.retryable === true
  const phaseMessage = payload?.detail?.phase?.message
  return {
    retryable,
    resultUnknown: requestSent && !retryable && !(
      payload?.detail?.platformSessionCreated === false && payload.detail.created === false
      && payload.detail.messageAccepted === false && payload.detail.resultUnknown === false
    ),
    serverSessionId: typeof payload?.detail?.sessionId === "string" ? payload.detail.sessionId : undefined,
    message: retryable && typeof phaseMessage === "string" && phaseMessage.trim()
      ? phaseMessage : error instanceof Error ? error.message : undefined,
  }
}

export function releaseCreationAttachments(files: AttachedFile[]) {
  for (const file of files) if (file.preview) URL.revokeObjectURL(file.preview)
}

/** Editors get their own previews; navigating away must not invalidate the retained draft. */
export function copyCreationAttachments(files: AttachedFile[]): AttachedFile[] {
  return files.map(file => ({ ...file, preview: file.type === "image" ? URL.createObjectURL(file.file) : undefined }))
}

export async function inlineAttachmentsFromFiles(files: AttachedFile[]): Promise<InlineAttachmentRef[]> {
  const inlineAttachments: InlineAttachmentRef[] = []
  for (const attachment of files) {
    const content = await attachment.file.arrayBuffer()
    const contentBase64 = arrayBufferToBase64(content)
    const sha256 = await sha256Hex(content)
    inlineAttachments.push({
      fileId: attachment.id.slice(0, 64),
      name: attachment.name,
      mediaType: attachment.file.type || "application/octet-stream",
      size: attachment.size,
      sha256,
      contentBase64,
    })
  }
  return inlineAttachments
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  const chunkSize = 0x8000
  let binary = ""
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
