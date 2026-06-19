package com.agentsanywhere.app.model

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

data class OAuthPending(
    val status: OAuthPendingStatus,
    val pendingToken: String,
    val suggestedUserId: String,
)

enum class OAuthPendingStatus {
    Authenticated,
    NeedsPassword,
    NeedsRegistration,
}
