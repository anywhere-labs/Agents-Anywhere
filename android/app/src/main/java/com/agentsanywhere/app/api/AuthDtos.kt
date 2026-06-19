package com.agentsanywhere.app.api

data class AuthResponse(
    val userId: String,
    val role: String,
    val accessToken: String,
    val tokenType: String,
    val serverTime: String,
)

data class AuthConfigResponse(
    val needsBootstrap: Boolean,
    val registrationOpen: Boolean,
    val oauthRegistrationOpen: Boolean,
    val oauthEnabled: Boolean,
    val oauthProviderLabel: String?,
    val setupTokenExpiresAt: String?,
    val serverTime: String,
)

data class OAuthStartResponse(
    val authorizeUrl: String,
    val serverTime: String,
)

data class OAuthFinalizeResponse(
    val auth: AuthResponse,
    val serverTime: String,
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
