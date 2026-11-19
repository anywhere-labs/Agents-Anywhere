package dev.agentsanywhere.v3poc.model

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The native session interface. MeshSessionsClient maps Connector RPC results into renderer events,
 * and MockSessionsClient replays fixtures through the same interface.
 * All methods are called on the main thread.
 */
interface SessionsClient {
    /** Snapshot, then whole replacements (`message` / `session` / `control`). Completes when the stream drops; watch again. */
    fun watch(id: String): Flow<JsonObject>

    /** Items before `beforeSeq`. */
    suspend fun listMessages(id: String, beforeSeq: Int?, limit: Int): Pair<List<JsonElement>, Boolean>

    /** Idempotent on `clientMsgId`; returns the message id. */
    suspend fun send(id: String, clientMsgId: String, content: String): String

    /** First answer wins; every watcher sees `control.answered`. */
    suspend fun answer(id: String, requestId: String, optionId: String)

    suspend fun stop(id: String)

    /** Returns the updated Session. */
    suspend fun setConfig(id: String, configId: String, value: String): JsonObject
}

class SessionsClientException(message: String) : Exception(message)

/**
 * The phone is a remote control with a cache: the latest snapshot plus replaced items per session, in memory only and
 * bounded (least recently used sessions are dropped). Reopening a session shows this at once; the new watch snapshot
 * then replaces it.
 */
class SessionCache(initialItems: Int = 300) {
    /** Most recently used last. */
    private val states = LinkedHashMap<String, SessionState>(16, 0.75f, true)
    var maxSessions = 8; private set
    var maxItems = initialItems; private set

    fun state(id: String): SessionState? = states[id]

    fun apply(event: JsonObject, id: String): SessionState? {
        if (event["type"].str == "snapshot") {
            SessionState.from(event)?.let { states[id] = it }
        } else {
            states[id]?.apply(event)
        }
        states[id]?.let { state ->
            // Trim in steps, not on every push, so the rebuild is rare.
            if (state.messages.size > maxItems + maxItems / 3) states[id] = state.keepingLast(maxItems)
        }
        evict()
        return states[id]
    }

    fun prepend(older: List<JsonElement>, hasMore: Boolean, id: String) {
        val state = states[id] ?: return
        states[id] = state.prepend(older, hasMore)
    }

    /** `warning`: keep only [keep] (the session on screen) and its last 120 items, from now on at most 4 sessions.
     *  `critical`: the last 60 items, at most 2 sessions. (Same as iOS `SessionCache.trim`.) */
    fun trim(level: String, keep: String?) {
        val critical = level == "critical"
        maxSessions = if (critical) 2 else 4
        maxItems = if (critical) 60 else 120
        states.keys.retainAll { it == keep }
        keep?.let { id -> states[id]?.let { states[id] = it.keepingLast(maxItems) } }
    }

    val itemCount: Int get() = states.values.sumOf { it.messages.size }
    val sessionCount: Int get() = states.size

    private fun evict() {
        while (states.size > maxSessions) states.remove(states.keys.first())
    }
}
