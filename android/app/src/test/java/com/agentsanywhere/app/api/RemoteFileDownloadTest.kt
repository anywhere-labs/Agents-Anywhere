package com.agentsanywhere.app.api

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RemoteFileDownloadTest {
    @Test
    fun downloadRefreshesExpiredAuthorization() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(401))
            server.enqueue(MockResponse().setBody("file contents"))
            val client = ApiClient(refreshAccessToken = { _, _ -> "renewed" })
            val data = client.getFileBytes(server.url("/").toString().trimEnd('/'),
                "/api/v2/connectors/device/fs/transfers/id?token=transfer", "expired")
            assertArrayEquals("file contents".toByteArray(), data)
            assertEquals("Bearer expired", server.takeRequest().getHeader("Authorization"))
            assertEquals("Bearer renewed", server.takeRequest().getHeader("Authorization"))
        }
    }

    @Test
    fun rejectsExternalDownloadUrls() {
        assertThrows(IllegalArgumentException::class.java) {
            ApiClient().getFileBytes("https://example.com", "https://other.example/file", "secret")
        }
    }

    @Test
    fun fileTransferChecksChecksumAndSize() {
        MockWebServer().use { server ->
            server.start()
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest("hello".toByteArray())
                .joinToString("") { "%02x".format(it) }
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{"result":{"downloadUrl":"/api/v2/connectors/device/fs/transfers/id?token=t","size":5,"sha256":"$digest"}}""",
            ))
            server.enqueue(MockResponse().setBody("hello"))
            val file = FilesApi(ApiClient()).downloadFile(server.url("/").toString().trimEnd('/'), "token", "device", "/workspace", "a.txt")
            assertArrayEquals("hello".toByteArray(), file)
            assertEquals("Bearer token", server.takeRequest().getHeader("Authorization"))
            assertEquals("Bearer token", server.takeRequest().getHeader("Authorization"))
        }
    }

    @Test
    fun fileTransferRejectsCorruptBytes() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{"result":{"downloadUrl":"/api/v2/connectors/device/fs/transfers/id?token=t","size":5,"sha256":"${"0".repeat(64)}"}}""",
            ))
            server.enqueue(MockResponse().setBody("hello"))
            assertThrows(IllegalArgumentException::class.java) {
                FilesApi(ApiClient()).downloadFile(server.url("/").toString().trimEnd('/'), "token", "device", "/workspace", "a.txt")
            }
        }
    }

    @Test
    fun createPreviewTokenReturnsToken() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{"previewToken":"test-preview-token-123","expiresAt":"2026-11-01T00:00:00Z","serverTime":"2026-11-01T00:00:00Z"}"""
            ))
            val token = FilesApi(ApiClient()).createPreviewToken(server.url("/").toString().trimEnd('/'), "token", "device", "/workspace", "index.html")
            assertEquals("test-preview-token-123", token)
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/v2/connectors/device/fs/preview-token?root=%2Fworkspace", request.path)
            assertEquals("Bearer token", request.getHeader("Authorization"))
        }
    }
}
