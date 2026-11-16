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
    /** Absent on Servers without E2EE: treated as off. */
    val e2ee: E2eeServerConfig = E2eeServerConfig(),
)

/** `GET /auth/config` 的 `e2ee` 字段：部署是否要求端到端加密。 */
data class E2eeServerConfig(
    val mode: String = MODE_OFF,
    /** `AGENT_SERVER_E2EE_WEB`: `"allow"` or `"deny"` (contracts: Server `E2eeConfigView`). */
    val web: String = ALLOW,
    /** `AGENT_SERVER_E2EE_PREVIEW`: `"allow"` or `"deny"`; port preview traffic is not end-to-end encrypted. */
    val preview: String = ALLOW,
) {
    val required: Boolean get() = mode == MODE_REQUIRED
    val previewAllowed: Boolean get() = preview != DENY

    companion object {
        const val MODE_OFF = "off"
        const val MODE_REQUIRED = "required"
        const val ALLOW = "allow"
        const val DENY = "deny"
    }
}

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
