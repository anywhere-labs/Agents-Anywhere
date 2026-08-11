package com.agentsanywhere.app.feature.terminal

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteTerminalAuthorizationTest {
    @Test
    fun `http 401 handshake is an authorization failure`() {
        assertTrue(isUnauthorizedTerminalConnection(httpStatusCode = 401))
    }

    @Test
    fun `v2 server 4401 close is an authorization failure`() {
        assertTrue(isUnauthorizedTerminalConnection(closeCode = 4401))
    }

    @Test
    fun `ordinary websocket failures keep existing reconnect behavior`() {
        assertFalse(isUnauthorizedTerminalConnection(httpStatusCode = 403))
        assertFalse(isUnauthorizedTerminalConnection(httpStatusCode = 500))
        assertFalse(isUnauthorizedTerminalConnection(closeCode = 1000))
        assertFalse(isUnauthorizedTerminalConnection(closeCode = 1006))
    }
}
