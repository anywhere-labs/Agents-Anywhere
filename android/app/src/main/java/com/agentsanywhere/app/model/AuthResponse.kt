package com.agentsanywhere.app.model

data class AuthResponse(
    val userId: String,
    val role: String,
    val accessToken: String,
    val tokenType: String,
    val serverTime: String,
)
