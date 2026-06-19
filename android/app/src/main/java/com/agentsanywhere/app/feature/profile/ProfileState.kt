package com.agentsanywhere.app.feature.profile

data class ProfileState(
    val displayName: String = "",
    val email: String = "",
    val serverUrl: String = "",
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
)
