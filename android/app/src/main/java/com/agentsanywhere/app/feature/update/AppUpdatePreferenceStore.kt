package com.agentsanywhere.app.feature.update

import android.content.Context

internal enum class AppUpdateDecision(val storedValue: String) {
    Accepted("accepted"),
    Deferred("deferred"),
}

internal class AppUpdatePreferenceStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun isDeferred(serverOrigin: String, versionCode: Int): Boolean {
        return preferences.getString(decisionKey(serverOrigin, versionCode), null) ==
            AppUpdateDecision.Deferred.storedValue
    }

    fun recordAccepted(serverOrigin: String, versionCode: Int) {
        recordDecision(serverOrigin, versionCode, AppUpdateDecision.Accepted)
    }

    fun recordDeferred(serverOrigin: String, versionCode: Int) {
        recordDecision(serverOrigin, versionCode, AppUpdateDecision.Deferred)
    }

    private fun recordDecision(
        serverOrigin: String,
        versionCode: Int,
        decision: AppUpdateDecision,
    ) {
        if (serverOrigin.isBlank() || versionCode <= 0) return
        preferences.edit()
            .putString(decisionKey(serverOrigin, versionCode), decision.storedValue)
            .commit()
    }

    private fun decisionKey(serverOrigin: String, versionCode: Int): String {
        return "$DECISION_KEY_PREFIX${serverOrigin.trim().trimEnd('/')}|$versionCode"
    }

    private companion object {
        const val PREFERENCES_NAME = "agents_anywhere_app_updates"
        const val DECISION_KEY_PREFIX = "decision|"
    }
}
