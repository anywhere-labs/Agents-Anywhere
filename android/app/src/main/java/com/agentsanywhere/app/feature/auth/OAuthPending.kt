package com.agentsanywhere.app.feature.auth

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
