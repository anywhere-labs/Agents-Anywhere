package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.net.Uri
import com.agentsanywhere.app.feature.sessiondetail.RuntimeMessageAction
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import org.json.JSONArray
import org.json.JSONObject

internal data class SessionComposerDraft(
    val text: String = "",
    val attachments: List<PendingAttachment> = emptyList(),
    val clientMessageId: String? = null,
    val retryAction: RuntimeMessageAction? = null,
)

class SessionComposerDraftStore(
    context: Context? = null,
    userId: String = "",
) {
    private val drafts = mutableMapOf<String, SessionComposerDraft>()
    private val preferences = context?.getSharedPreferences(
        "session-composer-drafts-${userId.hashCode()}",
        Context.MODE_PRIVATE,
    )

    internal fun restore(sessionId: String?, uploadCancelledMessage: String): SessionComposerDraft {
        if (sessionId == null) return SessionComposerDraft()
        val draft = drafts[sessionId]
            ?: preferences?.getString(sessionId, null)?.let(::decodeDraft)
            ?: return SessionComposerDraft()
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
        save(
            sessionId,
            normalized.text,
            normalized.attachments,
            normalized.clientMessageId,
            normalized.retryAction,
        )
        return normalized
    }

    internal fun save(
        sessionId: String?,
        text: String,
        attachments: List<PendingAttachment>,
        clientMessageId: String? = null,
        retryAction: RuntimeMessageAction? = null,
    ) {
        if (sessionId == null) return
        if (text.isBlank() && attachments.isEmpty()) {
            clear(sessionId)
        } else {
            val draft = SessionComposerDraft(
                text = text,
                attachments = attachments,
                clientMessageId = clientMessageId?.takeIf(String::isNotBlank),
                retryAction = retryAction,
            )
            drafts[sessionId] = draft
            preferences?.edit()?.putString(sessionId, encodeDraft(draft))?.apply()
        }
    }

    internal fun clear(sessionId: String?) {
        if (sessionId == null) return
        drafts.remove(sessionId)
        preferences?.edit()?.remove(sessionId)?.apply()
    }

    private fun encodeDraft(draft: SessionComposerDraft): String {
        return JSONObject()
            .put("text", draft.text)
            .put("clientMessageId", draft.clientMessageId)
            .put("retryAction", draft.retryAction?.name)
            .put(
                "attachments",
                JSONArray(
                    draft.attachments.map { attachment ->
                        JSONObject()
                            .put("uri", attachment.uri.toString())
                            .put("name", attachment.name)
                            .put("mediaType", attachment.mediaType)
                            .put("size", attachment.size)
                            .put("id", attachment.id)
                            .put("uploadState", attachment.uploadState.name)
                            .put("errorMessage", attachment.errorMessage)
                            .put(
                                "remote",
                                attachment.remote?.let { remote ->
                                    JSONObject()
                                        .put("fileId", remote.fileId)
                                        .put("name", remote.name)
                                        .put("mediaType", remote.mediaType)
                                        .put("size", remote.size)
                                        .put("sha256", remote.sha256)
                                },
                            )
                    },
                ),
            )
            .toString()
    }

    private fun decodeDraft(raw: String): SessionComposerDraft? = runCatching {
        val source = JSONObject(raw)
        val attachments = source.optJSONArray("attachments") ?: JSONArray()
        SessionComposerDraft(
            text = source.optString("text", ""),
            attachments = List(attachments.length()) { index ->
                val attachment = attachments.getJSONObject(index)
                val remote = attachment.optJSONObject("remote")?.let {
                    TimelineAttachment(
                        fileId = it.getString("fileId"),
                        name = it.optString("name", it.getString("fileId")),
                        mediaType = it.optString("mediaType", ""),
                        size = it.optLong("size", 0L),
                        sha256 = it.optString("sha256", "").takeIf(String::isNotBlank),
                    )
                }
                PendingAttachment(
                    uri = Uri.parse(attachment.optString("uri", "")),
                    name = attachment.optString("name", "attachment"),
                    mediaType = attachment.optString("mediaType", ""),
                    size = attachment.optLong("size", 0L),
                    id = attachment.optString("id", ""),
                    uploadState = runCatching {
                        AttachmentUploadState.valueOf(attachment.optString("uploadState"))
                    }.getOrDefault(AttachmentUploadState.Failed),
                    remote = remote,
                    errorMessage = attachment.optString("errorMessage", "").takeIf(String::isNotBlank),
                )
            },
            clientMessageId = source.optString("clientMessageId", "").takeIf(String::isNotBlank),
            retryAction = source.optString("retryAction", "")
                .takeIf(String::isNotBlank)
                ?.let { runCatching { RuntimeMessageAction.valueOf(it) }.getOrNull() },
        )
    }.getOrNull()
}
