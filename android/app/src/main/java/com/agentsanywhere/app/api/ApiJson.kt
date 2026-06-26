package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.optNullableString(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return optString(name).takeIf { it.isNotBlank() }
}

internal fun JSONObject?.toMap(): Map<String, Any?> {
    if (this == null) return emptyMap()
    return keys().asSequence().associateWith { key ->
        val value = opt(key)
        when (value) {
            JSONObject.NULL -> null
            is JSONObject -> value.toMap()
            is JSONArray -> List(value.length()) { index ->
                when (val item = value.opt(index)) {
                    JSONObject.NULL -> null
                    is JSONObject -> item.toMap()
                    is JSONArray -> List(item.length()) { nestedIndex -> item.opt(nestedIndex) }
                    else -> item
                }
            }
            else -> value
        }
    }
}

internal fun Map<String, Any?>.toJsonObject(): JSONObject {
    val json = JSONObject()
    forEach { (key, value) ->
        json.put(key, value ?: JSONObject.NULL)
    }
    return json
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
