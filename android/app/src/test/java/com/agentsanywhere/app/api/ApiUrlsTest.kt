package com.agentsanywhere.app.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ApiUrlsTest {
    @Test
    fun `apiPath adds v2 namespace once and preserves query`() {
        assertEquals("/api/v2/sessions", apiPath("/sessions"))
        assertEquals("/api/v2/sessions", apiPath("api/v2/sessions"))
        assertEquals("/api/v2/sessions?archived=false", apiPath("/api/v2/sessions?archived=false"))
        assertEquals("/api/v2/?page=1", apiPath("/?page=1"))
        assertEquals("/api/v2/sessions/", apiPath("/sessions/"))
    }

    @Test
    fun `apiUrl covers HTTP SSE file and legacy configured namespaces`() {
        assertEquals(
            "https://server.example.com/api/v2/sessions",
            apiUrl("https://server.example.com/api/v2", "/sessions"),
        )
        assertEquals(
            "https://server.example.com/api/v2/sessions/session-1/events?token=token",
            apiUrl(
                "https://server.example.com/",
                "/sessions/session-1/events?token=token",
            ),
        )
        assertEquals(
            "https://server.example.com/api/v2/connectors/device-1/fs/readText?root=%2Ftmp",
            apiUrl(
                "https://server.example.com/api/v2/",
                "/connectors/device-1/fs/readText?root=%2Ftmp",
            ),
        )
    }

    @Test
    fun `direct attachment and terminal URLs contain one namespace`() {
        assertEquals(
            "https://server.example.com/api/v2/sessions/session-1/attachments/file-1/open",
            SessionsApi().attachmentOpenUrl(
                serverUrl = "https://server.example.com/api/v2",
                sessionId = "session-1",
                fileId = "file-1",
            ),
        )
        assertEquals(
            "https://server.example.com/api/v2/sessions/session%2F1/attachments/file%2F1",
            SessionsApi().attachmentDownloadUrl(
                serverUrl = "https://server.example.com/api/v2",
                sessionId = "session/1",
                fileId = "file/1",
            ),
        )
        assertEquals(
            "wss://server.example.com/api/v2/connectors/device-1/terminals-v2/terminal-1/stream" +
                "?fromSeq=12&token=access%20token",
            TerminalApi().streamUrl(
                serverUrl = "https://server.example.com/api/v2/",
                authorizationToken = "access token",
                deviceId = "device-1",
                terminalId = "terminal-1",
                fromSeq = 12,
            ),
        )
    }

    @Test
    fun `server origin normalization accepts origins and strips legacy namespace`() {
        assertEquals("https://server.example.com", normalizeServerOrigin(" server.example.com/api/v2/ "))
        assertEquals("http://localhost:8080", normalizeServerOrigin("localhost:8080/api/v2"))
        assertEquals("http://192.168.1.20", normalizeServerOrigin("192.168.1.20/"))
        assertEquals("https://server.example.com", normalizeServerOrigin("https://server.example.com/"))
    }

    @Test
    fun `server origin normalization rejects non-origin URLs`() {
        assertNull(normalizeServerOrigin("ftp://server.example.com"))
        assertNull(normalizeServerOrigin("https://server.example.com/custom"))
        assertNull(normalizeServerOrigin("https://server.example.com?tenant=one"))
        assertNull(normalizeServerOrigin("https://user@server.example.com"))
    }
}
