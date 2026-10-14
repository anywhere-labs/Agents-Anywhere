package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginExchangeResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class AuthSessionStoreTest {
    private val serverUrl = "https://example.test"
    private val auth = AuthResponse("user", "member", "old", "bearer", "now")
    private val exchange = MobileLoginExchangeResponse(auth, "refresh", "expires", "now")
    private lateinit var store: AuthSessionStore
    private lateinit var original: MobileAuthSession

    @Before
    fun setUp() {
        store = AuthSessionStore(RuntimeEnvironment.getApplication())
        store.clearAuthSession()
        store.saveMobileAuthSession(serverUrl, exchange)
        original = store.readMobileAuthSession()
    }

    @Test
    fun refreshUpdatesAccessTokenAndRoleWithoutReplacingRefreshToken() {
        assertTrue(store.saveRefreshedAuthSession(original, auth.copy(accessToken = "new", role = "admin")))
        assertEquals(original.copy(accessToken = "new"), store.readMobileAuthSession())
        assertEquals("admin", store.readRole())
        assertEquals("user", store.readUserId())
    }

    @Test
    fun refreshCannotRestoreSignedOutSession() {
        store.clearAuthSession()
        assertFalse(store.saveRefreshedAuthSession(original, auth.copy(accessToken = "new")))
        assertFalse(store.hasAuthSession())
        assertEquals("", store.readMobileAuthSession().refreshToken)
    }

    @Test
    fun refreshCannotOverwriteNewLogin() {
        for (userId in listOf(auth.userId, "other-user")) {
            store.saveMobileAuthSession(serverUrl, exchange.copy(auth = auth.copy(userId = userId, accessToken = "other"), refreshToken = "other-refresh"))
            val newLogin = store.readMobileAuthSession()
            assertFalse(store.saveRefreshedAuthSession(original, auth.copy(accessToken = "new")))
            assertEquals(newLogin, store.readMobileAuthSession())
            store.saveMobileAuthSession(serverUrl, exchange)
        }
    }

    @Test
    fun refreshCannotOverwriteChangedServer() {
        store.saveServerUrl("https://other.test")
        val newSession = store.readMobileAuthSession()
        assertFalse(store.saveRefreshedAuthSession(original, auth.copy(accessToken = "new")))
        assertEquals(newSession, store.readMobileAuthSession())
    }

    @Test
    fun refreshRejectsResponseForDifferentUser() {
        assertFalse(store.saveRefreshedAuthSession(original, auth.copy(userId = "other-user", accessToken = "new")))
        assertEquals("user", store.readUserId())
        assertEquals(original, store.readMobileAuthSession())
    }
}
