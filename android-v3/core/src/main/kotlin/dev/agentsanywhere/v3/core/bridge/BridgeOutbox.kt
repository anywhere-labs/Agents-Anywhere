package dev.agentsanywhere.v3.core.bridge

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The native side of the `aa.render/2` bridge (docs/v3/mobile-bridge.md), without Android types so it can be tested:
 *  - every message is `{ v: 2, type, … }`;
 *  - nothing but queuing happens before the page says `ready`;
 *  - messages made within one frame (~16 ms) go out as one `batch { messages }`, in order.
 * The platform layer calls [enqueue], schedules [drain] on the next frame while [hasPending], and evaluates the
 * returned script.
 */
class BridgeOutbox {
    private val queue = ArrayList<JsonObject>()
    var ready: Boolean = false
        private set
    var pageVersion: String? = null
        private set
    var pageCapabilities: List<String> = emptyList()
        private set

    val hasPending: Boolean get() = ready && queue.isNotEmpty()

    /** Adds `v: 2` when missing. Returns true when a flush should be scheduled. */
    @Synchronized
    fun enqueue(message: JsonObject): Boolean {
        queue += if (message["v"] == null) JsonObject(mapOf("v" to JsonPrimitive(VERSION)) + message) else message
        return ready
    }

    /** The page loaded (again): it now accepts messages. */
    @Synchronized
    fun markReady(ready: JsonObject) {
        this.ready = true
        pageVersion = ready["version"].str
        pageCapabilities = (ready["capabilities"] as? JsonArray)?.mapNotNull { it.str }.orEmpty()
    }

    /** The page is gone or reloading: hold everything until the next `ready` (the caller re-sends its view state). */
    @Synchronized
    fun reset(dropQueued: Boolean) {
        ready = false
        if (dropQueued) queue.clear()
    }

    /** The message for this frame (one message as is, several as a `batch`), or null. */
    @Synchronized
    fun drainMessage(): JsonObject? {
        if (!ready || queue.isEmpty()) return null
        val out = if (queue.size == 1) queue[0] else JsonObject(mapOf(
            "v" to JsonPrimitive(VERSION),
            "type" to JsonPrimitive("batch"),
            "messages" to JsonArray(queue.toList()),
        ))
        queue.clear()
        return out
    }

    /** `window.aa.receive(<json>)` for this frame, or null. */
    fun drain(): String? = drainMessage()?.let(::script)

    companion object {
        const val VERSION = 2
        const val FRAME_MS = 16L

        fun script(message: JsonObject): String {
            // JSON is a JS expression; U+2028/2029 are escaped for older engines.
            val json = AAJson.encodeToString(JsonObject.serializer(), message).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
            return "window.aa&&window.aa.receive($json);void 0"
        }

        /** A page → native message (`AndroidAA.postMessage(JSON.stringify(obj))`), or null if it is not one. */
        fun parseInbound(json: String): JsonObject? {
            val obj = runCatching { AAJson.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return null
            return obj.takeIf { it["type"].str != null }
        }
    }
}
