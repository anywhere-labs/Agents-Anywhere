package com.agentsanywhere.app.feature.sessions

import android.content.Context
import java.security.MessageDigest

/** Operation IDs only, separated by account and server; no prompt or token is stored here. */
class RuntimeWorkflowReferenceStore(context: Context) {
    private val preferences = context.getSharedPreferences("runtime-workflow-references", Context.MODE_PRIVATE)
    private fun key(server: String, user: String): String = MessageDigest.getInstance("SHA-256").digest("$server\n$user".toByteArray()).joinToString("") { "%02x".format(it) }
    fun read(server: String, user: String): Set<String> = if (user.isBlank()) emptySet() else preferences.getStringSet(key(server, user), emptySet()).orEmpty().toSet()
    fun remember(server: String, user: String, id: String, remove: Boolean = false) {
        if (user.isBlank()) return
        val values = read(server, user).toMutableSet()
        if (remove) values.remove(id) else values.add(id)
        preferences.edit().putStringSet(key(server, user), values.toList().takeLast(32).toSet()).apply()
    }
}
