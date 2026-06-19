package com.agentsanywhere.app.api

import org.json.JSONObject
import java.net.URLEncoder

class AuthApi(
    private val client: ApiClient = ApiClient(),
) {
    fun authConfig(serverUrl: String): AuthConfigResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/auth/config",
        ).toAuthConfigResponse()
    }

    fun login(
        serverUrl: String,
        userId: String,
        password: String,
    ): AuthResponse {
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/login",
                body = JSONObject()
                    .put("userId", userId)
                    .put("password", password),
            ).toAuthResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401) {
                throw ApiException("Invalid User ID or password.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun startOAuth(
        serverUrl: String,
        returnTo: String,
    ): OAuthStartResponse {
        val encodedReturnTo = URLEncoder.encode(returnTo, Charsets.UTF_8.name())
        return try {
            client.getJson(
                serverUrl = serverUrl,
                path = "/auth/oauth/start?returnTo=$encodedReturnTo",
            ).toOAuthStartResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 404) {
                throw ApiException("OAuth is not configured on this server.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun finalizeOAuth(
        serverUrl: String,
        pendingToken: String,
        userId: String? = null,
        password: String? = null,
        setPassword: Boolean = false,
    ): OAuthFinalizeResponse {
        val body = JSONObject()
            .put("pendingToken", pendingToken)
            .put("setPassword", setPassword)
        if (!userId.isNullOrBlank()) {
            body.put("userId", userId)
        }
        if (!password.isNullOrBlank()) {
            body.put("password", password)
        }

        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/oauth/finalize",
                body = body,
            ).toOAuthFinalizeResponse()
        } catch (exc: ApiException) {
            throw when (exc.statusCode) {
                401 -> ApiException(oauthUnauthorizedMessage(exc.message), exc.statusCode, exc)
                403 -> ApiException("OAuth registration is closed. Contact your administrator to enable it.", exc.statusCode, exc)
                else -> exc
            }
        }
    }

    fun requestMobileLogin(
        serverUrl: String,
        userId: String,
        loginToken: String,
        deviceName: String?,
    ): MobileLoginStatusResponse {
        val body = JSONObject()
            .put("userId", userId)
            .put("loginToken", loginToken)
        if (!deviceName.isNullOrBlank()) {
            body.put("deviceName", deviceName)
        }
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/mobile-login/request",
                body = body,
            ).toMobileLoginStatusResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401) {
                throw ApiException("Invalid or expired QR code.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun mobileLoginStatus(
        serverUrl: String,
        loginToken: String,
    ): MobileLoginStatusResponse {
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/mobile-login/status",
                body = JSONObject().put("loginToken", loginToken),
            ).toMobileLoginStatusResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401 || exc.statusCode == 404) {
                throw ApiException("Invalid or expired QR code.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun exchangeMobileLogin(
        serverUrl: String,
        userId: String,
        loginToken: String,
    ): MobileLoginExchangeResponse {
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/mobile-login/exchange",
                body = JSONObject()
                    .put("userId", userId)
                    .put("loginToken", loginToken),
            ).toMobileLoginExchangeResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401) {
                throw ApiException("Invalid or expired QR code.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    private fun JSONObject.toAuthConfigResponse(): AuthConfigResponse {
        return AuthConfigResponse(
            needsBootstrap = optBoolean("needsBootstrap", false),
            registrationOpen = optBoolean("registrationOpen", false),
            oauthRegistrationOpen = optBoolean("oauthRegistrationOpen", false),
            oauthEnabled = optBoolean("oauthEnabled", false),
            oauthProviderLabel = optNullableString("oauthProviderLabel"),
            setupTokenExpiresAt = optNullableString("setupTokenExpiresAt"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toOAuthStartResponse(): OAuthStartResponse {
        return OAuthStartResponse(
            authorizeUrl = getString("authorizeUrl"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toOAuthFinalizeResponse(): OAuthFinalizeResponse {
        return OAuthFinalizeResponse(
            auth = getJSONObject("auth").toAuthResponse(),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toAuthResponse(): AuthResponse {
        return AuthResponse(
            userId = getString("userId"),
            role = getString("role"),
            accessToken = getString("accessToken"),
            tokenType = optString("tokenType", "bearer"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toMobileLoginStatusResponse(): MobileLoginStatusResponse {
        return MobileLoginStatusResponse(
            status = getString("status"),
            userId = optNullableString("userId"),
            deviceName = optNullableString("deviceName"),
            expiresAt = optNullableString("expiresAt"),
            requestedAt = optNullableString("requestedAt"),
            approvedAt = optNullableString("approvedAt"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toMobileLoginExchangeResponse(): MobileLoginExchangeResponse {
        return MobileLoginExchangeResponse(
            auth = getJSONObject("auth").toAuthResponse(),
            refreshToken = getString("refreshToken"),
            expiresAt = getString("expiresAt"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.optNullableString(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return optString(name).takeIf { it.isNotBlank() }
    }

    private fun oauthUnauthorizedMessage(message: String?): String {
        if (message == "oauth session expired") {
            return "OAuth session expired. Start sign-in again."
        }
        return "Password is required to link this account."
    }
}
