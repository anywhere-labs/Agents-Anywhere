package dev.agentsanywhere.v3.core.model

import dev.agentsanywhere.v3.core.get
import dev.agentsanywhere.v3.core.str
import kotlinx.serialization.json.JsonObject

/**
 * Native copy of one conversation, kept from `aa.v3.Sessions/watch`: every event carries the whole current value of
 * what changed, so items are replaced by id; a later snapshot replaces everything. Used for the composer, approval
 * dock and config pickers, and for the offline cache. The renderer gets the same events unchanged.
 */
class ConversationState(val sessionId: String) {
    var session: Session? = null
        private set
    var control: Control = Control()
        private set
    var hasMore: Boolean = false
        private set
    private val byId = LinkedHashMap<String, JsonObject>()

    val messages: List<JsonObject> get() = byId.values.sortedBy { messageSeq(it) }

    fun apply(event: WatchEvent) {
        when (event.type) {
            "snapshot" -> {
                event.session?.let { session = it }
                event.control?.let { control = it }
                hasMore = event.hasMore
                byId.clear()
                event.messages.forEach { m -> m["id"].str?.let { byId[it] = m } }
            }
            "message" -> event.message?.let { m -> m["id"].str?.let { byId[it] = m } }
            "session" -> event.session?.let { session = it }
            "control" -> event.control?.let { control = it }
        }
    }

    fun prepend(older: List<JsonObject>, hasMore: Boolean) {
        older.forEach { m -> m["id"].str?.let { id -> if (id !in byId) byId[id] = m } }
        this.hasMore = hasMore
    }

    fun restore(cached: dev.agentsanywhere.v3.core.cache.CachedConversation) {
        session = cached.session
        control = cached.control
        byId.clear()
        cached.messages.forEach { m -> m["id"].str?.let { byId[it] = m } }
    }

    val oldestSeq: Long? get() = byId.values.minOfOrNull { messageSeq(it) }
}
