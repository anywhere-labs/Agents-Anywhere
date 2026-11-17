package com.agentsanywhere.app.feature.sessiondetail

/** Process-local storage for user messages that have not yet been confirmed by the server. */
internal class SessionOptimisticMessageStore {
    private val lock = Any()
    private val messagesBySession = mutableMapOf<String, List<TimelineMessage>>()

    // Failed sends the user deleted. A read that started before the deletion still
    // carries them, so they stay out until the same message is sent again.
    private val discardedBySession = mutableMapOf<String, Set<String>>()

    fun read(sessionId: String): List<TimelineMessage> = synchronized(lock) {
        messagesBySession[sessionId].orEmpty()
    }

    fun isDiscarded(sessionId: String, messageId: String): Boolean = synchronized(lock) {
        messageId in discardedBySession[sessionId].orEmpty()
    }

    fun upsert(sessionId: String, message: TimelineMessage) {
        require(message.optimistic) { "Only optimistic messages may be stored." }
        synchronized(lock) {
            discardedBySession.removeMessage(sessionId, message.id)
            val messages = messagesBySession[sessionId].orEmpty().filterNot { it.id == message.id } + message
            messagesBySession[sessionId] = sortTimelineMessages(messages)
        }
    }

    fun replace(sessionId: String, messages: List<TimelineMessage>) {
        synchronized(lock) {
            val discarded = discardedBySession[sessionId].orEmpty()
            val pending = sortTimelineMessages(messages.filter { it.optimistic && it.id !in discarded })
            if (pending.isEmpty()) messagesBySession.remove(sessionId) else messagesBySession[sessionId] = pending
        }
    }

    fun discard(sessionId: String, messageId: String) {
        synchronized(lock) {
            discardedBySession[sessionId] = discardedBySession[sessionId].orEmpty() + messageId
            val remaining = messagesBySession[sessionId].orEmpty().filterNot { it.id == messageId }
            if (remaining.isEmpty()) messagesBySession.remove(sessionId) else messagesBySession[sessionId] = remaining
        }
    }

    fun move(fromSessionId: String, toSessionId: String) {
        if (fromSessionId == toSessionId) return
        synchronized(lock) {
            discardedBySession.remove(fromSessionId)?.let { discarded ->
                discardedBySession[toSessionId] = discardedBySession[toSessionId].orEmpty() + discarded
            }
            val source = messagesBySession.remove(fromSessionId).orEmpty()
            if (source.isEmpty()) return
            val merged = (messagesBySession[toSessionId].orEmpty() + source)
                .associateBy(TimelineMessage::id)
                .values
                .toList()
            messagesBySession[toSessionId] = sortTimelineMessages(merged)
        }
    }

    fun clear(sessionId: String) {
        synchronized(lock) {
            messagesBySession.remove(sessionId)
            discardedBySession.remove(sessionId)
        }
    }

    private fun MutableMap<String, Set<String>>.removeMessage(sessionId: String, messageId: String) {
        val remaining = get(sessionId)?.minus(messageId) ?: return
        if (remaining.isEmpty()) remove(sessionId) else put(sessionId, remaining)
    }
}
