package com.agentsanywhere.app.feature.sessions

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal data class NewSessionPreference(
    val connectorId: String,
    val runtimeId: String,
    val selections: Map<NewSessionRuntimeScope, NewSessionSelections> = emptyMap(),
)

internal class NewSessionPreferenceStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun read(): NewSessionPreference? {
        val raw = preferences.getString(KEY_PREFERENCE, null) ?: return null
        return decodeNewSessionPreference(raw)
    }

    fun save(
        connectorId: String,
        runtimeId: String,
        selections: NewSessionSelections,
    ) {
        if (connectorId.isBlank() || runtimeId.isBlank()) return
        val scope = NewSessionRuntimeScope(connectorId, runtimeId)
        val previous = read()?.selections.orEmpty()
        val nextSelections = if (selections.model == null && selections.permission == null) {
            previous - scope
        } else {
            previous + (scope to selections)
        }
        val preference = NewSessionPreference(
            connectorId = connectorId,
            runtimeId = runtimeId,
            selections = nextSelections,
        )
        preferences.edit()
            .putString(KEY_PREFERENCE, encodeNewSessionPreference(preference))
            .apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "agents-anywhere-new-session"
        const val KEY_PREFERENCE = "last-selection-v1"
    }
}

internal fun encodeNewSessionPreference(preference: NewSessionPreference): String {
    val selections = JSONArray()
    preference.selections
        .toList()
        .sortedWith(compareBy({ it.first.connectorId }, { it.first.runtimeId }))
        .forEach { (scope, selection) ->
            selections.put(
                JSONObject()
                    .put("connectorId", scope.connectorId)
                    .put("runtimeId", scope.runtimeId)
                    .put("model", selection.model)
                    .put("permission", selection.permission),
            )
        }
    return JSONObject()
        .put("connectorId", preference.connectorId)
        .put("runtimeId", preference.runtimeId)
        .put("selections", selections)
        .toString()
}

internal fun decodeNewSessionPreference(raw: String): NewSessionPreference? = runCatching {
    val source = JSONObject(raw)
    val connectorId = source.optString("connectorId").takeIf(String::isNotBlank)
        ?: return@runCatching null
    val runtimeId = source.optString("runtimeId").takeIf(String::isNotBlank)
        ?: return@runCatching null
    val entries = source.optJSONArray("selections") ?: JSONArray()
    val selections = buildMap {
        repeat(entries.length()) { index ->
            val entry = entries.optJSONObject(index) ?: return@repeat
            val entryConnectorId = entry.optString("connectorId").takeIf(String::isNotBlank)
                ?: return@repeat
            val entryRuntimeId = entry.optString("runtimeId").takeIf(String::isNotBlank)
                ?: return@repeat
            val model = entry.optionalString("model")
            val permission = entry.optionalString("permission")
            if (model == null && permission == null) return@repeat
            put(
                NewSessionRuntimeScope(entryConnectorId, entryRuntimeId),
                NewSessionSelections(model = model, permission = permission),
            )
        }
    }
    NewSessionPreference(
        connectorId = connectorId,
        runtimeId = runtimeId,
        selections = selections,
    )
}.getOrNull()

private fun JSONObject.optionalString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key).takeIf(String::isNotBlank)
}
