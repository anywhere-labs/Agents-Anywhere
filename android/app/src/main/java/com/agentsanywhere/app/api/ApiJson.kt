package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

internal fun JSONObject.optNullableString(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return optString(name).takeIf { it.isNotBlank() }
}

internal fun JSONObject.optNullableInt(name: String): Int? {
    if (!has(name) || isNull(name)) return null
    return optInt(name)
}

internal fun JSONObject.optNullableBoolean(name: String): Boolean? {
    if (!has(name) || isNull(name)) return null
    return opt(name) as? Boolean
}

internal fun JSONObject?.toMap(): Map<String, Any?> {
    if (this == null) return emptyMap()
    return keys().asSequence().associateWith { key -> opt(key).toKotlinValue() }
}

/** JSON text, such as a configuration field the user typed, as Kotlin values. Trailing text is an error. */
internal fun parseJsonValue(text: String): Any? {
    val tokener = JSONTokener(text)
    val value = tokener.nextValue()
    if (tokener.nextClean() != 0.toChar()) throw JSONException("Unexpected text after the JSON value")
    return value.toKotlinValue()
}

/** Indented JSON text for a value read with [toMap] or [parseJsonValue]. */
internal fun formatJsonValue(value: Any?): String {
    val text = when (val json = value.toJsonValue()) {
        is JSONObject -> json.toString(2)
        is JSONArray -> json.toString(2)
        is String -> JSONObject.quote(json)
        else -> json.toString()
    }
    return text.withoutEscapedSlashes()
}

/** Android escapes every "/" in strings; paths read better without it and parse the same. */
private fun String.withoutEscapedSlashes(): String {
    val out = StringBuilder(length)
    var index = 0
    while (index < length) {
        val char = this[index]
        if (char == '\\' && index + 1 < length) {
            // Escape pairs are copied whole, so an escaped backslash before "/" stays intact.
            val next = this[index + 1]
            if (next == '/') out.append('/') else out.append(char).append(next)
            index += 2
        } else {
            out.append(char)
            index += 1
        }
    }
    return out.toString()
}

private fun Any?.toKotlinValue(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> toMap()
    is JSONArray -> List(length()) { index -> opt(index).toKotlinValue() }
    else -> this
}

/**
 * Android's org.json writes a nested Map or List with toString(), so nested
 * values are converted before they are put into the request body.
 */
internal fun Map<String, Any?>.toJsonObject(): JSONObject {
    val json = JSONObject()
    forEach { (key, value) ->
        json.put(key, value.toJsonValue())
    }
    return json
}

private fun Any?.toJsonValue(): Any = when (this) {
    null -> JSONObject.NULL
    is Map<*, *> -> JSONObject().also { json ->
        forEach { (key, value) -> json.put(key.toString(), value.toJsonValue()) }
    }
    is Iterable<*> -> JSONArray().also { json -> forEach { json.put(it.toJsonValue()) } }
    is Array<*> -> JSONArray().also { json -> forEach { json.put(it.toJsonValue()) } }
    else -> this
}

internal inline fun <T> JSONArray?.toObjectList(
    transform: JSONObject.() -> T,
): List<T> {
    if (this == null) return emptyList()
    return List(length()) { index ->
        getJSONObject(index).transform()
    }
}

internal fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return List(length()) { index -> optString(index) }.filter { it.isNotBlank() }
}

internal fun String.urlEncode(): String {
    return java.net.URLEncoder.encode(this, Charsets.UTF_8.name()).replace("+", "%20")
}
