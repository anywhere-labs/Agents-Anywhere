package com.agentsanywhere.app.feature.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthSessionInvalidationTest {
    @Test
    fun `matching unauthorized token clears current session`() {
        assertTrue(shouldClearAuthSession("expired-token", "expired-token"))
    }

    @Test
    fun `stale unauthorized token cannot clear newer session`() {
        assertFalse(shouldClearAuthSession("new-token", "expired-token"))
    }

    @Test
    fun `blank unauthorized token cannot clear session`() {
        assertFalse(shouldClearAuthSession("current-token", ""))
    }

    @Test
    fun `duplicate unauthorized notification becomes a no-op after first clear`() {
        var currentToken = "expired-token"

        if (shouldClearAuthSession(currentToken, "expired-token")) {
            currentToken = ""
        }

        assertFalse(shouldClearAuthSession(currentToken, "expired-token"))
    }
}
