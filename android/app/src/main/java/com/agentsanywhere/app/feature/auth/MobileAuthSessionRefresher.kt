package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.normalizeServerOrigin

data class MobileAuthSession(
    val serverUrl: String,
    val accessToken: String,
    val refreshToken: String,
)

interface MobileAuthSessionStore {
    fun readMobileAuthSession(): MobileAuthSession

    fun saveRefreshedAuthSession(session: MobileAuthSession, auth: AuthResponse): Boolean
}

class MobileAuthSessionRefresher(
    private val sessionStore: MobileAuthSessionStore,
    private val api: AuthApi = AuthApi(),
) {
    private var lastRefresh: Triple<String, String, String>? = null

    @Synchronized
    fun refreshAccessToken(serverUrl: String, accessToken: String): String? {
        val session = sessionStore.readMobileAuthSession()
        if (session.serverUrl != normalizeServerOrigin(serverUrl)) return null
        if (session.accessToken != accessToken) {
            // Concurrent 401s may arrive after the first request has saved its refresh.
            return session.accessToken.takeIf {
                lastRefresh == Triple(session.serverUrl, accessToken, it)
            }
        }
        if (session.refreshToken.isBlank()) return null
        val auth = try {
            api.refreshMobileLogin(session.serverUrl, session.refreshToken)
        } catch (exc: ApiException) {
            if (exc.statusCode == 401 || exc.statusCode == 403) return null
            throw exc
        }
        if (!sessionStore.saveRefreshedAuthSession(session, auth)) return null
        lastRefresh = Triple(session.serverUrl, accessToken, auth.accessToken)
        return auth.accessToken
    }
}
