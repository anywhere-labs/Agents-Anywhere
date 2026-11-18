package dev.agentsanywhere.v3poc.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** One waiting approval, read from `control.pending[i]`. */
data class PendingRequest(val requestId: String, val messageId: String, val title: String, val options: List<Option>) {
    data class Option(val id: String, val name: String, val kind: String) {
        val isReject: Boolean get() = kind.startsWith("reject")
    }

    companion object {
        fun from(json: JsonElement?): PendingRequest? {
            val id = json["request_id"].str ?: return null
            return PendingRequest(
                requestId = id,
                messageId = json["message_id"].str ?: "",
                title = json["title"].str ?: "",
                options = json["options"].arr.orEmpty().mapNotNull { o ->
                    val oid = o["id"].str ?: return@mapNotNull null
                    Option(oid, o["name"].str ?: oid, o["kind"].str ?: "allow_once")
                },
            )
        }
    }
}

/** A v3 `ConfigOption` (model, permission mode, reasoning effort…), rendered generically by the options sheet. */
data class ConfigOption(val id: String, val name: String, val category: String?, val current: String, val options: List<Value>) {
    data class Value(val value: String, val name: String, val description: String?)

    val currentName: String get() = options.firstOrNull { it.value == current }?.name ?: current

    companion object {
        fun from(json: JsonElement): ConfigOption? {
            val id = json["id"].str ?: return null
            return ConfigOption(
                id = id,
                name = json["name"].str ?: id,
                category = json["category"].str,
                current = json["current"].str ?: "",
                options = json["options"].arr.orEmpty().mapNotNull { o ->
                    val v = o["value"].str ?: return@mapNotNull null
                    Value(v, o["name"].str ?: v, o["description"].str)
                },
            )
        }
    }
}

/**
 * What a `watch` stream leaves behind: the latest Session, Control and items, each replaced whole by id.
 * Used by the mock "computer" (the source of truth, which also assigns `seq`) and by the phone's `SessionCache`.
 */
class SessionState(var session: JsonObject, messages: List<JsonElement>, var control: JsonObject, var hasMore: Boolean) {
    private val list = ArrayList<JsonObject>()
    private val index = HashMap<String, Int>()
    private var nextSeq = 0
    val messages: List<JsonObject> get() = list

    init {
        for (m in messages) (m as? JsonObject)?.let { applyMessage(it, assignSeq = true, stamp = false) }
    }

    val snapshot: JsonObject
        get() = jsObj("type" to "snapshot", "session" to session, "messages" to JsonArray(list.toList()), "has_more" to hasMore, "control" to control)

    /**
     * Applies one watch event; returns it as watchers must see it (`assignSeq`: the source gives new items a `seq`;
     * `stamp`: the replayer also sets `created_at` to now the first time an id appears and keeps it afterwards).
     */
    fun apply(event: JsonObject, assignSeq: Boolean = false, stamp: Boolean = false): JsonObject {
        when (event["type"].str) {
            "snapshot" -> from(event)?.let { s ->
                session = s.session; control = s.control; hasMore = s.hasMore
                list.clear(); index.clear(); nextSeq = 0
                for (m in s.list) applyMessage(m, assignSeq = false, stamp = false)
            }
            "message" -> {
                val message = event["message"].obj ?: return event
                return jsObj("type" to "message", "message" to applyMessage(message, assignSeq, stamp))
            }
            "session" -> event["session"].obj?.let { session = it }
            "control" -> event["control"].obj?.let { control = it }
        }
        return event
    }

    private fun applyMessage(message: JsonObject, assignSeq: Boolean, stamp: Boolean): JsonObject {
        val id = message["id"].str ?: return message
        val position = index[id]
        return if (position != null) {
            val old = list[position]
            val kept = message.with(
                "seq" to (old["seq"] ?: message["seq"]),
                "created_at" to (if (stamp) old["created_at"] ?: message["created_at"] else message["created_at"]),
            )
            list[position] = kept
            kept
        } else {
            val seq = message["seq"].int ?: nextSeq
            var m = message
            if (assignSeq || message["seq"] == null) m = m.with("seq" to seq)
            if (stamp) m = m.with("created_at" to Clock.nowIso())
            index[id] = list.size
            list.add(m)
            nextSeq = maxOf(nextSeq, seq + 1)
            m
        }
    }

    fun message(id: String): JsonObject? = index[id]?.let { list[it] }
    val unfinishedMessages: List<JsonObject> get() = list.filter { it["done"].bool == false }

    /** Only the last [count] items (older ones come back through `loadOlder`). */
    fun keepingLast(count: Int): SessionState =
        if (list.size <= count) this else SessionState(session, list.takeLast(count), control, true)

    /** Older items prepended (a `list_messages` page). */
    fun prepend(older: List<JsonElement>, hasMore: Boolean): SessionState =
        SessionState(session, older + list, control, hasMore)

    // What native reads
    val activity: SessionActivity get() = SessionActivity.control(control)
    val pending: List<PendingRequest> get() = control["pending"].arr.orEmpty().mapNotNull(PendingRequest::from)

    companion object {
        fun from(event: JsonObject): SessionState? {
            if (event["type"].str != "snapshot") return null
            val session = event["session"].obj ?: return null
            return SessionState(session, event["messages"].arr.orEmpty(), event["control"].obj ?: JsonObject(emptyMap()), event["has_more"].bool ?: false)
        }
    }
}
