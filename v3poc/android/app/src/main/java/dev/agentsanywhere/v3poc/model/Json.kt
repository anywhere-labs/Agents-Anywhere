package dev.agentsanywhere.v3poc.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Events and items stay `JsonElement`: native forwards them to the renderer unchanged and only reads a few fields
 * (`type`, message `id` / `seq` / `parts[0]`, control `state` / `pending` / `usage`, session config).
 */
val AAJson = Json { ignoreUnknownKeys = true; encodeDefaults = false }

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
operator fun JsonElement?.get(index: Int): JsonElement? = (this as? JsonArray)?.getOrNull(index)
val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.longOrNull
val JsonElement?.int: Int? get() = (this as? JsonPrimitive)?.intOrNull ?: (this as? JsonPrimitive)?.doubleOrNull?.toInt()
val JsonElement?.double: Double? get() = (this as? JsonPrimitive)?.doubleOrNull
val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.booleanOrNull
val JsonElement?.arr: List<JsonElement>? get() = this as? JsonArray
val JsonElement?.obj: JsonObject? get() = this as? JsonObject

fun js(value: String?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)
fun js(value: Number): JsonElement = JsonPrimitive(value)
fun js(value: Boolean): JsonElement = JsonPrimitive(value)
fun jsArr(vararg items: JsonElement) = JsonArray(items.toList())
fun jsArr(items: List<JsonElement>) = JsonArray(items)

/** `jsObj("type" to "message", "message" to obj)`: Strings, numbers, booleans, null and JsonElements. */
fun jsObj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to toJson(v) })

fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is List<*> -> JsonArray(v.map(::toJson))
    is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x) })
    else -> JsonPrimitive(v.toString())
}

/** A copy with these keys replaced (null removes the key). */
fun JsonObject.with(vararg pairs: Pair<String, Any?>): JsonObject {
    val map = LinkedHashMap<String, JsonElement>(this)
    for ((k, v) in pairs) if (v == null) map.remove(k) else map[k] = toJson(v)
    return JsonObject(map)
}

/** Replaces every string (keys excluded) through `f`: the fixtures' "$TURN" / "$X" substitution. */
fun JsonElement.mapStrings(f: (String) -> String): JsonElement = when (this) {
    is JsonObject -> JsonObject(mapValues { it.value.mapStrings(f) })
    is JsonArray -> JsonArray(map { it.mapStrings(f) })
    is JsonPrimitive -> if (isString) JsonPrimitive(f(content)) else this
}

object Clock {
    fun nowIso(): String = DateTimeFormatter.ISO_INSTANT.format(Instant.now())
}
