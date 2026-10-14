package com.agentsanywhere.app.feature.auth

import android.content.Context
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginExchangeResponse
import com.agentsanywhere.app.api.normalizeServerOrigin

class AuthSessionStore(context: Context) : AuthSessionReader, MobileAuthSessionStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        "agents_anywhere_auth",
        Context.MODE_PRIVATE,
    )

    override fun readServerUrl(): String {
        val stored = preferences.getString(KEY_SERVER_URL, "").orEmpty()
        return normalizeServerOrigin(stored).orEmpty()
    }

    override fun readAccessToken(): String {
        return preferences.getString(KEY_ACCESS_TOKEN, "").orEmpty()
    }

    fun readUserId(): String {
        return preferences.getString(KEY_USER_ID, "").orEmpty()
    }

    fun readRole(): String {
        return preferences.getString(KEY_ROLE, "").orEmpty()
    }

    fun hasAuthSession(): Boolean {
        return readServerUrl().isNotBlank() && readAccessToken().isNotBlank()
    }

    @Synchronized
    fun saveServerUrl(serverUrl: String) {
        val origin = serverUrl.asServerOrigin()
        preferences.edit()
            .apply { if (readServerUrl() != origin) clear() }
            .putString(KEY_SERVER_URL, origin)
            .apply()
    }

    @Synchronized
    fun saveAuthSession(serverUrl: String, auth: AuthResponse) {
        preferences.edit()
            .putString(KEY_SERVER_URL, serverUrl.asServerOrigin())
            .putString(KEY_ACCESS_TOKEN, auth.accessToken)
            .putString(KEY_TOKEN_TYPE, auth.tokenType)
            .putString(KEY_USER_ID, auth.userId)
            .putString(KEY_ROLE, auth.role)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_REFRESH_EXPIRES_AT)
            .apply()
    }

    @Synchronized
    fun saveMobileAuthSession(serverUrl: String, exchange: MobileLoginExchangeResponse) {
        preferences.edit()
            .putString(KEY_SERVER_URL, serverUrl.asServerOrigin())
            .putString(KEY_ACCESS_TOKEN, exchange.auth.accessToken)
            .putString(KEY_TOKEN_TYPE, exchange.auth.tokenType)
            .putString(KEY_USER_ID, exchange.auth.userId)
            .putString(KEY_ROLE, exchange.auth.role)
            .putString(KEY_REFRESH_TOKEN, exchange.refreshToken)
            .putString(KEY_REFRESH_EXPIRES_AT, exchange.expiresAt)
            .apply()
    }

    @Synchronized
    override fun readMobileAuthSession(): MobileAuthSession {
        return MobileAuthSession(
            serverUrl = readServerUrl(),
            accessToken = readAccessToken(),
            refreshToken = preferences.getString(KEY_REFRESH_TOKEN, "").orEmpty(),
        )
    }

    @Synchronized
    override fun saveRefreshedAuthSession(session: MobileAuthSession, auth: AuthResponse): Boolean {
        if (readMobileAuthSession() != session || readUserId() != auth.userId) return false
        preferences.edit()
            .putString(KEY_ACCESS_TOKEN, auth.accessToken)
            .putString(KEY_TOKEN_TYPE, auth.tokenType)
            .putString(KEY_ROLE, auth.role)
            .apply()
        return true
    }

    @Synchronized
    fun clearAuthSession() {
        clearAuthSessionKeepingServerUrl()
    }

    @Synchronized
    fun clearAuthSessionIfTokenMatches(accessToken: String): Boolean {
        if (!shouldClearAuthSession(readAccessToken(), accessToken)) return false
        clearAuthSessionKeepingServerUrl()
        return true
    }

    private fun clearAuthSessionKeepingServerUrl() {
        val serverUrl = readServerUrl()
        preferences.edit()
            .clear()
            .putString(KEY_SERVER_URL, serverUrl)
            .apply()
    }

    private fun String.asServerOrigin(): String {
        return requireNotNull(normalizeServerOrigin(this)) {
            "Server URL must be an HTTP(S) origin."
        }
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_TOKEN_TYPE = "token_type"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_ROLE = "role"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_REFRESH_EXPIRES_AT = "refresh_expires_at"
    }
}

interface AuthSessionReader {
    fun readServerUrl(): String

    fun readAccessToken(): String
}

internal fun shouldClearAuthSession(currentAccessToken: String, unauthorizedAccessToken: String): Boolean {
    return unauthorizedAccessToken.isNotBlank() && currentAccessToken == unauthorizedAccessToken
}
