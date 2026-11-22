package dev.agentsanywhere.v3.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The JSON settings every AA v3 payload uses: snake_case fields as declared, unknown fields ignored (a newer
 * Connector or control plane may add some), absent optionals omitted on the wire (`.nullish()` on the TS side).
 */
val AAJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
    coerceInputValues = true
    isLenient = false
}

// Small, null-safe accessors for payloads kept as raw JSON (messages are forwarded to the renderer unchanged).

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
operator fun JsonElement?.get(index: Int): JsonElement? = (this as? JsonArray)?.getOrNull(index)
val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.contentOrNull
val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.longOrNull
val JsonElement?.double: Double? get() = (this as? JsonPrimitive)?.doubleOrNull
val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.booleanOrNull
val JsonElement?.obj: JsonObject? get() = this as? JsonObject
val JsonElement?.arr: List<JsonElement> get() = (this as? JsonArray) ?: emptyList()

/** Builds a JsonObject from Kotlin values (String, Number, Boolean, null, JsonElement, Map, List). */
fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.filter { it.second != null }.associate { (k, v) -> k to toJson(v) })

fun toJson(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.filter { it.value != null }.associate { (k, v) -> k.toString() to toJson(v) })
    is Iterable<*> -> JsonArray(value.map { toJson(it) })
    is Array<*> -> JsonArray(value.map { toJson(it) })
    else -> JsonPrimitive(value.toString())
}
