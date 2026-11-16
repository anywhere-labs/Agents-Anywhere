package com.agentsanywhere.app.api

import org.json.JSONObject

/** One message waiting in the server-owned session queue. */
data class RemoteSessionQueueItem(
    val messageId: String,
    val sessionId: String,
    val clientMessageId: String,
    val content: String,
    /** `queued`, `sending` or `failed`. */
    val status: String,
    val position: Int,
    val interruptRequested: Boolean,
    val attachmentCount: Int,
    val errorCode: String?,
    val errorMessage: String?,
)

/** The whole queue; every change replaces it and raises [revision]. */
data class RemoteSessionQueueState(
    val sessionId: String,
    val revision: Long,
    val items: List<RemoteSessionQueueItem>,
)

internal fun JSONObject.toSessionQueueState(): RemoteSessionQueueState? {
    val sessionId = optString("sessionId").takeIf(String::isNotBlank) ?: return null
    if (!has("revision")) return null
    val array = optJSONArray("items") ?: return null
    val items = (0 until array.length()).mapNotNull { index ->
        array.optJSONObject(index)?.toSessionQueueItem()
    }
    return RemoteSessionQueueState(sessionId = sessionId, revision = optLong("revision"), items = items)
}

private fun JSONObject.toSessionQueueItem(): RemoteSessionQueueItem? {
    val messageId = optString("messageId").takeIf(String::isNotBlank) ?: return null
    val error = optJSONObject("error")
    return RemoteSessionQueueItem(
        messageId = messageId,
        sessionId = optString("sessionId"),
        clientMessageId = optString("clientMessageId"),
        content = optString("content"),
        status = optString("status", "queued"),
        position = optInt("position", 0),
        interruptRequested = optBoolean("interruptRequested", false),
        attachmentCount = optJSONArray("attachments")?.length() ?: 0,
        errorCode = error?.optString("code")?.takeIf(String::isNotBlank),
        errorMessage = error?.optString("message")?.takeIf(String::isNotBlank),
    )
}
