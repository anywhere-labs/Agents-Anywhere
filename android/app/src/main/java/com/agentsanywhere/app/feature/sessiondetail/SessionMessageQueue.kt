package com.agentsanywhere.app.feature.sessiondetail

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

enum class SessionSendMode { Queue, Steer }
enum class QueuedMessageStatus { Queued, Sending, Interrupting, Failed }

data class QueuedSessionMessage(
    val id: String,
    val content: String,
    val attachments: List<TimelineAttachment> = emptyList(),
    val selections: Map<String, String?> = emptyMap(),
    val status: QueuedMessageStatus = QueuedMessageStatus.Queued,
    val editing: Boolean = false,
) {
    val locked: Boolean get() = status == QueuedMessageStatus.Sending || status == QueuedMessageStatus.Interrupting
}

data class SessionMessageQueueState(
    val messages: List<QueuedSessionMessage> = emptyList(),
    val paused: Boolean = false,
    val pauseGeneration: Long = 0,
) {
    fun shouldQueue(mode: SessionSendMode?): Boolean =
        mode == SessionSendMode.Queue || (mode == null && messages.isNotEmpty() && !paused)
}

/** Local to one server/account. Requests interrupted by process death require explicit retry. */
class SessionMessageQueueStore(context: Context? = null, accountKey: String = "") {
    private val preferences = context?.applicationContext?.getSharedPreferences(
        "session-message-queues-${accountKey.hashCode()}", Context.MODE_PRIVATE,
    )
    private val queues = mutableMapOf<String, MutableStateFlow<SessionMessageQueueState>>()

    fun observe(sessionId: String): StateFlow<SessionMessageQueueState> = flow(sessionId)
    fun read(sessionId: String): SessionMessageQueueState = flow(sessionId).value

    private fun flow(sessionId: String): MutableStateFlow<SessionMessageQueueState> = queues.getOrPut(sessionId) {
        MutableStateFlow(preferences?.getString(sessionId, null)?.let(::decodeMessageQueue) ?: SessionMessageQueueState())
    }

    private fun write(sessionId: String, state: SessionMessageQueueState) {
        flow(sessionId).value = state
        preferences?.edit()?.putString(sessionId, encodeMessageQueue(state))?.apply()
    }

    fun enqueue(sessionId: String, message: QueuedSessionMessage) {
        val state = read(sessionId)
        if (state.messages.none { it.id == message.id }) write(sessionId, state.copy(messages = state.messages + message))
    }

    fun remove(sessionId: String, id: String) {
        val state = read(sessionId)
        write(sessionId, state.copy(messages = state.messages.filterNot { it.id == id && !it.locked }))
    }

    fun edit(sessionId: String, id: String, editing: Boolean, content: String? = null) {
        val state = read(sessionId)
        write(sessionId, state.copy(messages = state.messages.map {
            if (it.id != id || it.locked || (content != null && content.isBlank() && it.attachments.isEmpty())) it
            else it.copy(editing = editing, content = content ?: it.content)
        }))
    }

    fun pause(sessionId: String) {
        val state = read(sessionId)
        write(sessionId, state.copy(paused = true, pauseGeneration = state.pauseGeneration + 1))
    }

    fun resume(sessionId: String, expectedGeneration: Long? = null) {
        val state = read(sessionId)
        if (expectedGeneration == null || expectedGeneration == state.pauseGeneration) write(sessionId, state.copy(paused = false))
    }

    fun claimNext(sessionId: String): QueuedSessionMessage? {
        val state = read(sessionId)
        val next = state.messages.firstOrNull() ?: return null
        if (state.paused || next.status != QueuedMessageStatus.Queued || next.editing || state.messages.any { it.locked }) return null
        write(sessionId, state.copy(messages = state.messages.map {
            if (it.id == next.id) it.copy(status = QueuedMessageStatus.Sending) else it
        }))
        return next
    }

    fun claimImmediate(sessionId: String, id: String): Boolean {
        val state = read(sessionId)
        val message = state.messages.firstOrNull { it.id == id } ?: return false
        if (state.paused || message.editing || state.messages.any { it.locked }) return false
        write(sessionId, state.copy(messages = state.messages.map {
            if (it.id == id) it.copy(status = QueuedMessageStatus.Interrupting) else it
        }))
        return true
    }

    fun finishImmediate(sessionId: String, id: String, ready: Boolean) {
        val state = read(sessionId)
        val message = state.messages.firstOrNull { it.id == id } ?: return
        write(sessionId, state.copy(messages = if (ready) {
            listOf(message.copy(status = QueuedMessageStatus.Queued)) + state.messages.filterNot { it.id == id }
        } else state.messages.map { if (it.id == id) it.copy(status = QueuedMessageStatus.Failed) else it }))
    }

    fun finishSend(sessionId: String, id: String, sent: Boolean) {
        val state = read(sessionId)
        write(sessionId, state.copy(messages = if (sent) state.messages.filterNot { it.id == id }
        else state.messages.map { if (it.id == id) it.copy(status = QueuedMessageStatus.Failed) else it }))
    }

    fun reconcile(sessionId: String, echoedIds: Set<String>) {
        val state = read(sessionId)
        val remaining = state.messages.filterNot { it.id in echoedIds }
        if (remaining.size != state.messages.size) write(sessionId, state.copy(messages = remaining))
    }
}

internal fun encodeMessageQueue(state: SessionMessageQueueState): String = JSONObject()
    .put("paused", state.paused)
    .put("messages", JSONArray(state.messages.map { message ->
        JSONObject().put("id", message.id).put("content", message.content).put("status", message.status.name)
            .put("selections", JSONObject().apply { message.selections.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) } })
            .put("attachments", JSONArray(message.attachments.map {
                JSONObject().put("fileId", it.fileId).put("name", it.name).put("mediaType", it.mediaType)
                    .put("size", it.size).put("sha256", it.sha256)
            }))
    })).toString()

internal fun decodeMessageQueue(json: String): SessionMessageQueueState? = runCatching {
    val source = JSONObject(json)
    val messages = source.getJSONArray("messages")
    SessionMessageQueueState(paused = source.optBoolean("paused"), messages = List(messages.length()) { index ->
        val message = messages.getJSONObject(index)
        val attachments = message.getJSONArray("attachments")
        val selections = message.getJSONObject("selections")
        QueuedSessionMessage(
            id = message.getString("id"), content = message.getString("content"),
            status = if (message.optString("status") == QueuedMessageStatus.Queued.name) QueuedMessageStatus.Queued else QueuedMessageStatus.Failed,
            selections = selections.keys().asSequence().associateWith { if (selections.isNull(it)) null else selections.getString(it) },
            attachments = List(attachments.length()) { attachmentIndex ->
                val attachment = attachments.getJSONObject(attachmentIndex)
                TimelineAttachment(fileId = attachment.getString("fileId"), name = attachment.getString("name"),
                    mediaType = attachment.getString("mediaType"), size = attachment.getLong("size"),
                    sha256 = attachment.optString("sha256").takeIf { it.isNotBlank() && it != "null" })
            },
        )
    })
}.getOrNull()

internal fun SessionRuntimeStatus.isBusyForMessageQueue(): Boolean = this in setOf(
    SessionRuntimeStatus.Waiting, SessionRuntimeStatus.Pending, SessionRuntimeStatus.Running,
    SessionRuntimeStatus.Stopping, SessionRuntimeStatus.WaitingApproval, SessionRuntimeStatus.Blocked,
)
