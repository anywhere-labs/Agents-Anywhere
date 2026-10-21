package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.sessiondetail.RuntimeInputRequestDraft
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

internal data class RuntimeNoticeDraft(
    val selectedActionId: String? = null,
    val rawValues: Map<String, String> = emptyMap(),
    val answers: Map<String, RuntimeInputRequestDraft> = emptyMap(),
)

@Composable
internal fun rememberRuntimeNoticeDraftStore(): RuntimeNoticeDraftStore {
    val context = LocalContext.current.applicationContext
    val auth = remember(context) { AuthSessionStore(context) }
    val serverUrl = auth.readServerUrl()
    val userId = auth.readUserId()
    return remember(context, serverUrl, userId) {
        RuntimeNoticeDraftStore.forAccount(context, serverUrl, userId)
    }
}

internal class RuntimeNoticeDraftStore private constructor(context: Context, accountKey: String) {
    private val preferences = context.getSharedPreferences(
        "runtime-notice-drafts-$accountKey",
        Context.MODE_PRIVATE,
    )
    // Only dirty drafts stay in memory. All cards and response handlers share this store.
    private val pending = mutableMapOf<String, RuntimeNoticeDraft>()

    fun restore(sessionId: String, noticeId: String): RuntimeNoticeDraft {
        val key = key(sessionId, noticeId)
        return pending[key] ?: preferences.getString(key, null)?.let(::decode) ?: RuntimeNoticeDraft()
    }

    fun update(sessionId: String, noticeId: String, draft: RuntimeNoticeDraft) {
        pending[key(sessionId, noticeId)] = draft
    }

    fun flush(sessionId: String, noticeId: String) {
        val key = key(sessionId, noticeId)
        val draft = pending.remove(key) ?: return
        val hasAnswer = draft.answers.values.any {
            it.optionIds.isNotEmpty() || it.customText.isNotEmpty() || it.useCustom
        }
        if (draft.selectedActionId == null && draft.rawValues.values.all(String::isEmpty) && !hasAnswer) {
            preferences.edit().remove(key).apply()
        } else {
            preferences.edit().putString(key, encode(draft)).apply()
        }
    }

    fun clear(sessionId: String, noticeId: String) {
        val key = key(sessionId, noticeId)
        pending.remove(key)
        preferences.edit().remove(key).apply()
    }

    private fun key(sessionId: String, noticeId: String): String =
        JSONArray(listOf(sessionId, noticeId)).toString()

    private fun encode(draft: RuntimeNoticeDraft): String = JSONObject()
        .put("selectedActionId", draft.selectedActionId)
        .put("rawValues", JSONObject(draft.rawValues))
        .put("answers", JSONObject().apply {
            draft.answers.forEach { (id, answer) ->
                put(id, JSONObject()
                    .put("optionIds", JSONArray(answer.optionIds))
                    .put("customText", answer.customText)
                    .put("useCustom", answer.useCustom))
            }
        })
        .toString()

    private fun decode(raw: String): RuntimeNoticeDraft? = runCatching {
        val source = JSONObject(raw)
        val rawValues = source.optJSONObject("rawValues") ?: JSONObject()
        val answers = source.optJSONObject("answers") ?: JSONObject()
        RuntimeNoticeDraft(
            selectedActionId = source.optString("selectedActionId", "").takeIf(String::isNotEmpty),
            rawValues = rawValues.keys().asSequence().associateWith { rawValues.getString(it) },
            answers = answers.keys().asSequence().associateWith { id ->
                val answer = answers.getJSONObject(id)
                val options = answer.optJSONArray("optionIds") ?: JSONArray()
                RuntimeInputRequestDraft(
                    optionIds = List(options.length()) { options.getString(it) },
                    customText = answer.optString("customText", ""),
                    useCustom = answer.optBoolean("useCustom", false),
                )
            },
        )
    }.getOrNull()

    companion object {
        private val accounts = mutableMapOf<String, RuntimeNoticeDraftStore>()

        fun forAccount(context: Context, serverUrl: String, userId: String): RuntimeNoticeDraftStore {
            val scope = JSONArray(listOf(serverUrl, userId)).toString()
            val accountKey = MessageDigest.getInstance("SHA-256")
                .digest(scope.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            return accounts.getOrPut(accountKey) {
                RuntimeNoticeDraftStore(context.applicationContext, accountKey)
            }
        }
    }
}
