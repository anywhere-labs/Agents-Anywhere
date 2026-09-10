package com.agentsanywhere.app.feature.sessions

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal data class NewSessionPreference(
    val connectorId: String,
    val runtimeId: String,
    val selections: Map<NewSessionRuntimeScope, NewSessionSelections> = emptyMap(),
)

internal class NewSessionPreferenceStore(context: Context, serverUrl: String, userId: String) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val key = if (serverUrl.isNotBlank() && userId.isNotBlank()) {
        "last-selection-v2:" + JSONArray(listOf(serverUrl.trim().trimEnd('/'), userId)).toString()
    } else null

    fun read(): NewSessionPreference? {
        val storageKey = key ?: return null
        preferences.getString(storageKey, null)?.let { return decodeNewSessionPreference(it) }
        val legacy = preferences.getString(KEY_PREFERENCE, null)?.let(::decodeNewSessionPreference) ?: return null
        // Adopt the old unscoped preference once, for the account performing the upgrade.
        preferences.edit().putString(storageKey, encodeNewSessionPreference(legacy)).remove(KEY_PREFERENCE).apply()
        return legacy
    }

    fun saveTarget(connectorId: String, runtimeId: String): NewSessionPreference? =
        update(connectorId, runtimeId) { it }

    fun saveModel(connectorId: String, runtimeId: String, model: String): NewSessionPreference? =
        update(connectorId, runtimeId) { it.copy(model = model) }

    fun savePermission(connectorId: String, runtimeId: String, permission: String): NewSessionPreference? =
        update(connectorId, runtimeId) { it.copy(permission = permission) }

    fun save(
        connectorId: String,
        runtimeId: String,
        selections: NewSessionSelections,
    ): NewSessionPreference? = update(connectorId, runtimeId) { selections }

    private fun update(
        connectorId: String,
        runtimeId: String,
        transform: (NewSessionSelections) -> NewSessionSelections,
    ): NewSessionPreference? {
        val storageKey = key ?: return null
        if (connectorId.isBlank() || runtimeId.isBlank()) return null
        val scope = NewSessionRuntimeScope(connectorId, runtimeId)
        val previous = read()?.selections.orEmpty()
        val selections = transform(previous[scope] ?: NewSessionSelections())
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
            .putString(storageKey, encodeNewSessionPreference(preference))
            .apply()
        return preference
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
