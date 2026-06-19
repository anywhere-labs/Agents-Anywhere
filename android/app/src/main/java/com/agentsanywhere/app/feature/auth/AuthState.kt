package com.agentsanywhere.app.feature.auth

data class AuthState(
    val serverUrl: String = "",
    val userId: String = "",
    val password: String = "",
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null,
)

data class QrLoginState(
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null,
)

data class QrWaitingState(
    val status: String = "pending_web_confirm",
    val isExchanging: Boolean = false,
    val errorMessage: String? = null,
)
