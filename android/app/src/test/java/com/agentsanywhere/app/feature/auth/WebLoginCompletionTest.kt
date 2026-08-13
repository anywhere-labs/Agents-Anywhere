package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.OAuthTokenResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class WebLoginCompletionTest {
    @Test
    fun sessionIsSavedOnlyAfterMeValidatesTheExchangedToken() {
        var saved: AuthResponse? = null
        assertThrows(IllegalStateException::class.java) {
            completeWebLoginSession(
                token = token(),
                loadMe = { throw IllegalStateException("invalid token") },
                saveSession = { saved = it },
            )
        }
        assertNull(saved)

        completeWebLoginSession(
            token = token(),
            loadMe = {
                AuthMeResponse(
                    userId = "user",
                    role = "member",
                    disabled = false,
                    avatar = null,
                    serverTime = "2026-08-12T00:00:00Z",
                )
            },
            saveSession = { saved = it },
        )

        assertEquals("user", saved?.userId)
        assertEquals("member", saved?.role)
        assertEquals("access-token", saved?.accessToken)
        assertEquals("Bearer", saved?.tokenType)
    }

    private fun token() = OAuthTokenResponse(
        accessToken = "access-token",
        tokenType = "Bearer",
        expiresIn = 3600,
        scope = "profile",
        refreshToken = null,
    )
}
