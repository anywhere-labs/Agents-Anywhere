package com.agentsanywhere.app.feature.sessiondetail

import androidx.compose.runtime.mutableStateListOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

internal data class PendingMessage(
    val id: String = UUID.randomUUID().toString(),
    val sessionId: String,
    val text: String,
    val attachments: List<TimelineAttachment> = emptyList(),
    val clientMessageId: String = "opt_${UUID.randomUUID()}",
)

/**
 * App-scoped delivery queue. It must outlive the conversation screen: switching
 * conversations or sending the activity to the background may dispose the
 * screen, but the pending message still has to be delivered when the session
 * becomes idle.
 *
 * The actual transport is still SessionDetailController.sendMessage; the DSH
 * bridge queues messages natively once the server accepts them. Failed sends
 * stay in this list and are retried, so they are never silently dropped.
 */
internal object PendingMessageQueue {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val messages = mutableStateListOf<PendingMessage>()
    private var controller: SessionDetailController? = null
    private var worker: Job? = null

    fun start(controller: SessionDetailController) {
        this.controller = controller
        if (worker?.isActive == true) return
        worker = scope.launch {
            while (isActive) {
                val current = controller
                if (current != null) {
                    for (message in messages.toList()) {
                        current.sendMessage(
                            sessionId = message.sessionId,
                            content = message.text,
                            clientMessageId = message.clientMessageId,
                            uploadedAttachments = message.attachments,
                        ).onSuccess {
                            messages.removeAll { it.id == message.id }
                        }
                    }
                }
                delay(2_500)
            }
        }
    }

    fun enqueue(
        sessionId: String,
        text: String,
        attachments: List<TimelineAttachment>,
    ): String? {
        if (text.isBlank() && attachments.isEmpty()) return null
        val message = PendingMessage(
            sessionId = sessionId,
            text = text,
            attachments = attachments,
        )
        messages.add(message)
        return message.id
    }

    fun remove(id: String) {
        messages.removeAll { it.id == id }
    }

    fun forSession(sessionId: String): List<PendingMessage> =
        messages.filter { it.sessionId == sessionId }
}
