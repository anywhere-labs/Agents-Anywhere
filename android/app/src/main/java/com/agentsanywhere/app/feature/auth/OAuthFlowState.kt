package com.agentsanywhere.app.feature.auth

data class OAuthFlowState(
    val serverUrl: String,
    val pending: OAuthPending,
)
