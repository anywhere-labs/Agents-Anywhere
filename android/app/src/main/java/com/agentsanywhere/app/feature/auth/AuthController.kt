package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginStatusResponse
import com.agentsanywhere.app.api.normalizeServerOrigin
import com.agentsanywhere.app.model.MobileLoginQrPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject

class AuthController(
    private val api: AuthApi,
    private val sessionStore: AuthSessionStore,
) {
    fun savedServerUrl(): String {
        return sessionStore.readServerUrl()
    }

    fun savedUserId(): String {
        return sessionStore.readUserId()
    }

    fun savedRole(): String {
        return sessionStore.readRole()
    }

    fun signOut() {
        sessionStore.clearAuthSession()
    }

    fun normalizedServerUrl(serverUrl: String): String? {
        return normalizeServerUrl(serverUrl)
    }

    suspend fun me(): Result<AuthMeResponse> {
        val serverUrl = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || token.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to load account."))
        }
        return withContext(Dispatchers.IO) {
            runCatching {
                api.me(serverUrl = serverUrl, token = token)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load account.", error)
            }
        }
    }

    suspend fun updateAvatar(avatar: String): Result<AuthMeResponse> {
        val serverUrl = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || token.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to update avatar."))
        }
        return withContext(Dispatchers.IO) {
            runCatching {
                api.updateAvatar(serverUrl = serverUrl, token = token, avatar = avatar)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not update avatar.", error)
            }
        }
    }

    suspend fun clearAvatar(): Result<AuthMeResponse> {
        val serverUrl = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || token.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to clear avatar."))
        }
        return withContext(Dispatchers.IO) {
            runCatching {
                api.clearAvatar(serverUrl = serverUrl, token = token)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not clear avatar.", error)
            }
        }
    }

    suspend fun accountAuthConfig(): Result<com.agentsanywhere.app.api.AuthConfigResponse> =
        withAccountCredentials { serverUrl, _ -> api.authConfig(serverUrl) }

    suspend fun updateDisplayName(displayName: String): Result<AuthMeResponse> =
        withAccountCredentials { serverUrl, token -> api.updateDisplayName(serverUrl, token, displayName) }

    suspend fun sendEmailCode(email: String): Result<com.agentsanywhere.app.api.EmailCodeResponse> =
        withAccountCredentials { serverUrl, token -> api.sendEmailCode(serverUrl, token, email) }

    suspend fun bindEmail(email: String, code: String?): Result<AuthMeResponse> =
        withAccountCredentials { serverUrl, token -> api.bindEmail(serverUrl, token, email, code) }

    private suspend fun <T> withAccountCredentials(action: (String, String) -> T): Result<T> {
        val serverUrl = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || token.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to update account."))
        }
        return withContext(Dispatchers.IO) {
            try {
                Result.success(action(serverUrl, token))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Result.failure(error)
            }
        }
    }

    suspend fun changePassword(newPassword: String): Result<Unit> {
        if (newPassword.length < 8) {
            return Result.failure(IllegalArgumentException("Password must be at least 8 characters."))
        }
        val serverUrl = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || token.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to change password."))
        }
        return withContext(Dispatchers.IO) {
            runCatching {
                api.changePassword(serverUrl = serverUrl, token = token, newPassword = newPassword)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not change password.", error)
            }
        }
    }

    suspend fun createWebLoginSession(serverUrl: String): Result<WebLoginSession> {
        val normalizedServerUrl = normalizeServerUrl(serverUrl)
            ?: return Result.failure(IllegalArgumentException("Enter a valid server URL."))

        return withContext(Dispatchers.IO) {
            runCatching {
                api.authConfig(serverUrl = normalizedServerUrl)
                api.requireWebLoginHost(serverUrl = normalizedServerUrl)
                sessionStore.saveServerUrl(normalizedServerUrl)
                com.agentsanywhere.app.feature.auth.createWebLoginSession(normalizedServerUrl)
            }.recoverCatching { error ->
                if (error is CancellationException) throw error
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not reach the server.", error)
            }
        }
    }

    fun parseWebLoginCallback(
        callbackUrl: String,
        session: WebLoginSession,
    ): WebLoginCallback = com.agentsanywhere.app.feature.auth.parseWebLoginCallback(callbackUrl, session)

    suspend fun completeWebLogin(
        session: WebLoginSession,
        code: String,
    ): Result<Unit> {
        if (code.isBlank()) {
            return Result.failure(IllegalArgumentException("Missing authorization code."))
        }
        return withContext(Dispatchers.IO) {
            runCatching {
                val token = api.oauthToken(
                    serverUrl = session.serverUrl,
                    code = code,
                    codeVerifier = session.codeVerifier,
                )
                currentCoroutineContext().ensureActive()
                val operationContext = currentCoroutineContext()
                completeWebLoginSession(
                    token = token,
                    loadMe = { accessToken ->
                        api.me(serverUrl = session.serverUrl, token = accessToken)
                    },
                    saveSession = { auth ->
                        operationContext.ensureActive()
                        sessionStore.saveAuthSession(session.serverUrl, auth)
                    },
                )
            }.recoverCatching { error ->
                if (error is CancellationException) throw error
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not complete web sign-in.", error)
            }
        }
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
        return normalizeServerOrigin(serverUrl)
    }

}

internal fun completeWebLoginSession(
    token: com.agentsanywhere.app.api.OAuthTokenResponse,
    loadMe: (String) -> AuthMeResponse,
    saveSession: (AuthResponse) -> Unit,
) {
    val me = loadMe(token.accessToken)
    saveSession(
        AuthResponse(
            userId = me.userId,
            email = me.email,
            displayName = me.displayName,
            emailVerified = me.emailVerified,
            role = me.role,
            accessToken = token.accessToken,
            tokenType = token.tokenType,
            serverTime = me.serverTime,
        ),
    )
}
