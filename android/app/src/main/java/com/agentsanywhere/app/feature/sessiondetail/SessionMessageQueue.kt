package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteSessionQueueItem
import com.agentsanywhere.app.api.RemoteSessionQueueState

const val SESSION_QUEUE_CAPABILITY = "session.queue"
const val SESSION_STEER_CAPABILITY = "session.steer"

/** How the composer hands a message to the session. */
enum class MessageDelivery {
    /** Start a new turn now (the session is idle). */
    Send,

    /** Wait in the server queue until the current turn ends. */
    Queue,

    /** Jump to the head of the queue and interrupt the current turn. */
    Interrupt,

    /** Add the message to the running turn; it does not go through the queue. */
    Steer,
}

/** Value of the `queue` request field, or null when the message is sent directly. */
internal val MessageDelivery.queueField: String?
    get() = when (this) {
        MessageDelivery.Queue -> "auto"
        MessageDelivery.Interrupt -> "interrupt"
        MessageDelivery.Send, MessageDelivery.Steer -> null
    }

/** Session states in which a new message waits instead of starting a turn. */
internal val QUEUEABLE_RUNTIME_STATUSES = setOf(
    SessionRuntimeStatus.Waiting,
    SessionRuntimeStatus.Pending,
    SessionRuntimeStatus.Running,
    SessionRuntimeStatus.Stopping,
    SessionRuntimeStatus.WaitingApproval,
    SessionRuntimeStatus.Blocked,
)

/** Keep the newest whole-queue snapshot; an older revision never wins. */
internal fun mergeQueueState(
    current: RemoteSessionQueueState?,
    next: RemoteSessionQueueState?,
): RemoteSessionQueueState? {
    if (next == null) return current
    if (current != null && current.sessionId == next.sessionId && current.revision > next.revision) return current
    return next
}

/**
 * Whether a new message has to wait in the queue. A message also waits
 * behind earlier ones, so the queue keeps its order while the session is
 * momentarily idle.
 */
internal fun messageMustWait(status: SessionRuntimeStatus, queue: RemoteSessionQueueState?): Boolean =
    status in QUEUEABLE_RUNTIME_STATUSES || !queue?.items.isNullOrEmpty()

enum class QueuePause {
    /** The head failed to send; later messages wait behind it. */
    Failed,

    /** The last turn ended in an error; the queue waits for "continue". */
    Error,
}

internal fun queuePause(status: SessionRuntimeStatus, queue: RemoteSessionQueueState?): QueuePause? {
    val head = queue?.items?.firstOrNull() ?: return null
    if (head.status == "failed") return QueuePause.Failed
    if (status == SessionRuntimeStatus.Error && head.status == "queued") return QueuePause.Error
    return null
}

internal fun RemoteSessionQueueItem.editable(): Boolean = status != "sending"
