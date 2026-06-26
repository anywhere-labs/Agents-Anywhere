package com.agentsanywhere.app.feature.auth

import android.content.Context
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginExchangeResponse

class AuthSessionStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "agents_anywhere_auth",
        Context.MODE_PRIVATE,
    )

    fun readServerUrl(): String {
        return preferences.getString(KEY_SERVER_URL, "").orEmpty()
    }

    fun readAccessToken(): String {
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

    fun saveServerUrl(serverUrl: String) {
        preferences.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .apply()
    }

    fun saveAuthSession(serverUrl: String, auth: AuthResponse) {
        preferences.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_ACCESS_TOKEN, auth.accessToken)
            .putString(KEY_TOKEN_TYPE, auth.tokenType)
            .putString(KEY_USER_ID, auth.userId)
            .putString(KEY_ROLE, auth.role)
            .apply()
    }

    fun saveMobileAuthSession(serverUrl: String, exchange: MobileLoginExchangeResponse) {
        preferences.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_ACCESS_TOKEN, exchange.auth.accessToken)
            .putString(KEY_TOKEN_TYPE, exchange.auth.tokenType)
            .putString(KEY_USER_ID, exchange.auth.userId)
            .putString(KEY_ROLE, exchange.auth.role)
            .putString(KEY_REFRESH_TOKEN, exchange.refreshToken)
            .putString(KEY_REFRESH_EXPIRES_AT, exchange.expiresAt)
            .apply()
    }

    fun clearAuthSession() {
        val serverUrl = readServerUrl()
        preferences.edit()
            .clear()
            .putString(KEY_SERVER_URL, serverUrl)
            .apply()
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
