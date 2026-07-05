package com.agentsanywhere.app.ui.screens.sessiondetail

internal data class SessionComposerDraft(
    val text: String = "",
    val attachments: List<PendingAttachment> = emptyList(),
)

class SessionComposerDraftStore {
    private val drafts = mutableMapOf<String, SessionComposerDraft>()

    internal fun restore(sessionId: String?, uploadCancelledMessage: String): SessionComposerDraft {
        if (sessionId == null) return SessionComposerDraft()
        val draft = drafts[sessionId] ?: return SessionComposerDraft()
        val normalized = draft.copy(
            attachments = draft.attachments.map { attachment ->
                if (attachment.uploadState == AttachmentUploadState.Uploading) {
                    attachment.copy(
                        uploadState = AttachmentUploadState.Failed,
                        errorMessage = attachment.errorMessage ?: uploadCancelledMessage,
                    )
                } else {
                    attachment
                }
            },
        )
        save(sessionId, normalized.text, normalized.attachments)
        return normalized
    }

    internal fun save(
        sessionId: String?,
        text: String,
        attachments: List<PendingAttachment>,
    ) {
        if (sessionId == null) return
        if (text.isBlank() && attachments.isEmpty()) {
            drafts.remove(sessionId)
        } else {
            drafts[sessionId] = SessionComposerDraft(text = text, attachments = attachments)
        }
    }

    internal fun clear(sessionId: String?) {
        if (sessionId != null) drafts.remove(sessionId)
    }
}
