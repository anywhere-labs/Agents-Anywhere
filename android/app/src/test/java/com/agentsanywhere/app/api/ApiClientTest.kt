package com.agentsanywhere.app.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

class ApiClientTest {
    @Test
    fun `authenticated 401 notifies unauthorized listener`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)

        client.notifyUnauthorized(statusCode = 401, authorizationToken = "expired-token")

        assertEquals(listOf("expired-token"), notifiedTokens)
    }

    @Test
    fun `query-authenticated stream 401 notifies unauthorized listener`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)
        val error = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { serverSocket ->
            val serverThread = thread {
                serverSocket.accept().use { socket ->
                    val reader = socket.getInputStream().bufferedReader()
                    while (!reader.readLine().isNullOrEmpty()) Unit
                    val body = "{\"detail\":\"invalid user access token\"}"
                    socket.getOutputStream().bufferedWriter().use { writer ->
                        writer.write("HTTP/1.1 401 Unauthorized\r\n")
                        writer.write("Content-Type: application/json\r\n")
                        writer.write("Content-Length: ${body.toByteArray(Charsets.UTF_8).size}\r\n")
                        writer.write("Connection: close\r\n\r\n")
                        writer.write(body)
                    }
                }
            }
            val result = runCatching {
                client.streamSse(
                    serverUrl = "http://${serverSocket.inetAddress.hostAddress}:${serverSocket.localPort}",
                    path = "/events?token=expired-stream-token",
                    authorizationToken = "expired-stream-token",
                    onEvent = {},
                )
            }
            serverThread.join(1_000)
            result.exceptionOrNull()
        }

        assertEquals(listOf("expired-stream-token"), notifiedTokens)
        assertTrue(error is ApiException && error.statusCode == 401)
    }

    @Test
    fun `unauthenticated 401 does not notify unauthorized listener`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)

        client.notifyUnauthorized(statusCode = 401, authorizationToken = null)
        client.notifyUnauthorized(statusCode = 401, authorizationToken = "")

        assertEquals(emptyList<String>(), notifiedTokens)
    }

    @Test
    fun `authenticated non-401 does not notify unauthorized listener`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)

        client.notifyUnauthorized(statusCode = 403, authorizationToken = "valid-token")
        client.notifyUnauthorized(statusCode = 500, authorizationToken = "valid-token")

        assertEquals(emptyList<String>(), notifiedTokens)
    }
}
