package com.agentsanywhere.app.api

data class AuthResponse(
    val userId: String,
    val role: String,
    val accessToken: String,
    val tokenType: String,
    val serverTime: String,
    val email: String? = null,
    val displayName: String = "",
    val emailVerified: Boolean = false,
)

data class AuthMeResponse(
    val userId: String,
    val role: String,
    val disabled: Boolean,
    val avatar: String?,
    val serverTime: String,
    val email: String? = null,
    val displayName: String = "",
    val emailVerified: Boolean = false,
) {
    val accountLabel: String
        get() = displayName.ifBlank { email.orEmpty() }
}

data class AuthConfigResponse(
    val needsBootstrap: Boolean,
    val registrationOpen: Boolean,
    val oauthRegistrationOpen: Boolean,
    val oauthEnabled: Boolean,
    val oauthProviderLabel: String?,
    val setupTokenExpiresAt: String?,
    val serverTime: String,
    val emailVerificationRequired: Boolean = false,
)

data class OAuthTokenResponse(
    val accessToken: String,
    val tokenType: String,
    val expiresIn: Int,
    val scope: String,
    val refreshToken: String?,
)

data class MobileLoginStatusResponse(
    val status: String,
    val userId: String?,
    val deviceName: String?,
    val expiresAt: String?,
    val requestedAt: String?,
    val approvedAt: String?,
    val serverTime: String,
)

data class MobileLoginExchangeResponse(
    val auth: AuthResponse,
    val refreshToken: String,
    val expiresAt: String,
    val serverTime: String,
)

data class EmailCodeResponse(
    val expiresIn: Int,
    val retryAfter: Int,
)
