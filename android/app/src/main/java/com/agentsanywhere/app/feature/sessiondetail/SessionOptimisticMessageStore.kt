package com.agentsanywhere.app.feature.sessiondetail

/** Process-local storage for user messages that have not yet been confirmed by the server. */
internal class SessionOptimisticMessageStore {
    private val lock = Any()
    private val messagesBySession = mutableMapOf<String, List<TimelineMessage>>()

    fun read(sessionId: String): List<TimelineMessage> = synchronized(lock) {
        messagesBySession[sessionId].orEmpty()
    }

    fun upsert(sessionId: String, message: TimelineMessage) {
        require(message.optimistic) { "Only optimistic messages may be stored." }
        synchronized(lock) {
            val messages = messagesBySession[sessionId].orEmpty().filterNot { it.id == message.id } + message
            messagesBySession[sessionId] = sortTimelineMessages(messages)
        }
    }

    fun replace(sessionId: String, messages: List<TimelineMessage>) {
        synchronized(lock) {
            val pending = sortTimelineMessages(messages.filter { it.optimistic })
            if (pending.isEmpty()) messagesBySession.remove(sessionId) else messagesBySession[sessionId] = pending
        }
    }

    fun move(fromSessionId: String, toSessionId: String) {
        if (fromSessionId == toSessionId) return
        synchronized(lock) {
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
        synchronized(lock) { messagesBySession.remove(sessionId) }
    }
}
