package com.agentsanywhere.app.feature.realtime

import android.content.Context
import java.util.UUID

class RealtimeClientIdStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "agents_anywhere_realtime",
        Context.MODE_PRIVATE,
    )

    @Synchronized
    fun readOrCreate(): String {
        preferences.getString(KEY_CLIENT_ID, null)?.takeIf(String::isNotBlank)?.let { return it }
        val created = "android-${UUID.randomUUID()}"
        preferences.edit().putString(KEY_CLIENT_ID, created).apply()
        return created
    }

    private companion object {
        const val KEY_CLIENT_ID = "client_id"
    }
}
