package com.agentsanywhere.app.feature.auth

import android.net.Uri
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.AuthConfigResponse
import com.agentsanywhere.app.api.MobileLoginStatusResponse
import com.agentsanywhere.app.model.MobileLoginQrPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

class AuthController(
    private val api: AuthApi,
    private val sessionStore: AuthSessionStore,
) {
    fun savedServerUrl(): String {
        return sessionStore.readServerUrl()
    }

    fun normalizedServerUrl(serverUrl: String): String? {
        return normalizeServerUrl(serverUrl)
    }

    suspend fun loginWithPassword(
        serverUrl: String,
        userId: String,
        password: String,
    ): Result<Unit> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))
        val trimmedUserId = userId.trim()
        if (trimmedUserId.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter your User ID."))
        }
        if (password.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter your password."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                sessionStore.saveServerUrl(normalizedServerUrl)
                val auth = api.login(
                    serverUrl = normalizedServerUrl,
                    userId = trimmedUserId,
                    password = password,
                )
                sessionStore.saveAuthSession(normalizedServerUrl, auth)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Login failed.", error)
            }
        }
    }

    suspend fun startOAuth(
        serverUrl: String,
        returnTo: String,
    ): Result<String> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))

        return withContext(Dispatchers.IO) {
            runCatching {
                sessionStore.saveServerUrl(normalizedServerUrl)
                api.startOAuth(
                    serverUrl = normalizedServerUrl,
                    returnTo = returnTo,
                ).authorizeUrl
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "OAuth sign-in failed.", error)
            }
        }
    }

    suspend fun authConfig(serverUrl: String): Result<AuthConfigResponse> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))

        return withContext(Dispatchers.IO) {
            runCatching {
                sessionStore.saveServerUrl(normalizedServerUrl)
                api.authConfig(serverUrl = normalizedServerUrl)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not check auth configuration.", error)
            }
        }
    }

    suspend fun finalizeBoundOAuth(
        serverUrl: String,
        pendingToken: String,
        userId: String,
        password: String,
    ): Result<Unit> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))
        val trimmedUserId = userId.trim()
        if (trimmedUserId.isBlank()) {
            return Result.failure(IllegalArgumentException("Missing matched User ID."))
        }
        if (password.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter your password."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                val response = api.finalizeOAuth(
                    serverUrl = normalizedServerUrl,
                    pendingToken = pendingToken,
                    userId = trimmedUserId,
                    password = password,
                    setPassword = false,
                )
                sessionStore.saveAuthSession(normalizedServerUrl, response.auth)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "OAuth sign-in failed.", error)
            }
        }
    }

    suspend fun finalizeNewOAuthAccount(
        serverUrl: String,
        pendingToken: String,
        userId: String,
        password: String,
    ): Result<Unit> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))
        val trimmedUserId = userId.trim()
        if (trimmedUserId.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter your User ID."))
        }
        if (password.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter your password."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                val response = api.finalizeOAuth(
                    serverUrl = normalizedServerUrl,
                    pendingToken = pendingToken,
                    userId = trimmedUserId,
                    password = password,
                    setPassword = true,
                )
                sessionStore.saveAuthSession(normalizedServerUrl, response.auth)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "OAuth sign-in failed.", error)
            }
        }
    }

    suspend fun finalizeAuthenticatedOAuth(
        serverUrl: String,
        pendingToken: String,
    ): Result<Unit> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))

        return withContext(Dispatchers.IO) {
            runCatching {
                val response = api.finalizeOAuth(
                    serverUrl = normalizedServerUrl,
                    pendingToken = pendingToken,
                )
                sessionStore.saveAuthSession(normalizedServerUrl, response.auth)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "OAuth sign-in failed.", error)
            }
        }
    }

    fun parseOAuthCallback(uri: Uri?): OAuthCallbackResult? {
        if (uri == null) return null
        if (uri.scheme != OAUTH_CALLBACK_SCHEME || uri.host != OAUTH_CALLBACK_HOST) return null

        val error = uri.getQueryParameter("oauth_error")
        if (!error.isNullOrBlank()) {
            return OAuthCallbackResult.Error(error)
        }

        val statusText = uri.getQueryParameter("oauth_status") ?: return null
        val pendingToken = uri.getQueryParameter("oauth_pending").orEmpty()
        if (pendingToken.isBlank()) {
            return OAuthCallbackResult.Error("OAuth sign-in failed.")
        }
        val suggestedUserId = uri.getQueryParameter("oauth_user").orEmpty()
        val status = when (statusText) {
            "authenticated" -> OAuthPendingStatus.Authenticated
            "needs_password" -> OAuthPendingStatus.NeedsPassword
            "needs_registration" -> OAuthPendingStatus.NeedsRegistration
            else -> return OAuthCallbackResult.Error("OAuth sign-in failed.")
        }
        return OAuthCallbackResult.Pending(
            OAuthPending(
                status = status,
                pendingToken = pendingToken,
                suggestedUserId = suggestedUserId,
            ),
        )
    }

    suspend fun requestMobileLoginFromQr(
        qrValue: String,
        deviceName: String,
    ): Result<MobileLoginQrPayload> {
        val payload = parseMobileLoginQrPayload(qrValue)
            ?: return Result.failure(IllegalArgumentException("Scan a valid Agents Anywhere QR code."))

        return withContext(Dispatchers.IO) {
            runCatching {
                sessionStore.saveServerUrl(payload.serverUrl)
                api.requestMobileLogin(
                    serverUrl = payload.serverUrl,
                    userId = payload.userId,
                    loginToken = payload.loginToken,
                    deviceName = deviceName,
                )
                payload
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "QR sign-in request failed.", error)
            }
        }
    }

    suspend fun mobileLoginStatus(
        payload: MobileLoginQrPayload,
    ): Result<MobileLoginStatusResponse> {
        return withContext(Dispatchers.IO) {
            runCatching {
                api.mobileLoginStatus(
                    serverUrl = payload.serverUrl,
                    loginToken = payload.loginToken,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not check QR sign-in status.", error)
            }
        }
    }

    suspend fun exchangeMobileLogin(
        payload: MobileLoginQrPayload,
    ): Result<Unit> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val exchange = api.exchangeMobileLogin(
                    serverUrl = payload.serverUrl,
                    userId = payload.userId,
                    loginToken = payload.loginToken,
                )
                sessionStore.saveMobileAuthSession(payload.serverUrl, exchange)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not complete QR sign-in.", error)
            }
        }
    }

    private fun parseMobileLoginQrPayload(qrValue: String): MobileLoginQrPayload? {
        return runCatching {
            val json = JSONObject(qrValue)
            if (json.optString("type") != "agents-anywhere.mobile-login") return null
            val serverUrl = json.optString("serverUrl")
                .ifBlank { json.optString("webUrl") }
                .let { normalizeServerUrl(it) }
                ?: return null
            val userId = json.optString("userId").takeIf { it.isNotBlank() } ?: return null
            val loginToken = json.optString("loginToken").takeIf { it.isNotBlank() } ?: return null
            MobileLoginQrPayload(
                serverUrl = serverUrl,
                userId = userId,
                loginToken = loginToken,
                expiresAt = json.optString("expiresAt").takeIf { it.isNotBlank() },
            )
        }.getOrNull()
    }

    private fun normalizeServerUrl(serverUrl: String): String? {
        val trimmed = serverUrl.trim().trimEnd('/')
        if (trimmed.isBlank()) return null
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
        if (trimmed.contains("://")) return null

        val host = trimmed.substringBefore('/').substringBefore(':').lowercase()
        if (host.isBlank()) return null

        val scheme = if (usesLocalNetworkHost(host) || trimmed.contains(':')) {
            "http"
        } else {
            "https"
        }
        return "$scheme://$trimmed"
    }

    private fun usesLocalNetworkHost(host: String): Boolean {
        if (host == "localhost" || host.endsWith(".local")) return true
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        return when {
            octets.any { it !in 0..255 } -> false
            octets[0] == 10 -> true
            octets[0] == 127 -> true
            octets[0] == 192 && octets[1] == 168 -> true
            octets[0] == 172 && octets[1] in 16..31 -> true
            else -> false
        }
    }

    companion object {
        const val OAUTH_CALLBACK_URI = "agents-anywhere://oauth/callback"
        private const val OAUTH_CALLBACK_SCHEME = "agents-anywhere"
        private const val OAUTH_CALLBACK_HOST = "oauth"
    }
}

sealed interface OAuthCallbackResult {
    data class Pending(val pending: OAuthPending) : OAuthCallbackResult
    data class Error(val message: String) : OAuthCallbackResult
}
