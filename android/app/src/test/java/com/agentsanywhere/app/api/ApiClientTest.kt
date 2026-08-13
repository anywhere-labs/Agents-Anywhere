package com.agentsanywhere.app.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class ApiClientTest {
    @Test
    fun `authenticated json 401 notifies unauthorized listener`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)

        val error = withHttpResponse(401) { serverUrl ->
            client.getJson(
                serverUrl = serverUrl,
                path = "/sessions",
                authorizationToken = "expired-json-token",
            )
        }

        assertApiException(error, 401)
        assertEquals(listOf("expired-json-token"), notifiedTokens)
    }

    @Test
    fun `authenticated multipart 401 notifies unauthorized listener`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)

        val error = withHttpResponse(401) { serverUrl ->
            client.postMultipart(
                serverUrl = serverUrl,
                path = "/files",
                files = listOf(
                    UploadFilePart(
                        name = "note.txt",
                        mediaType = "text/plain",
                        bytes = "hello".toByteArray(),
                    ),
                ),
                authorizationToken = "expired-upload-token",
            )
        }

        assertApiException(error, 401)
        assertEquals(listOf("expired-upload-token"), notifiedTokens)
    }

    @Test
    fun `unauthenticated 401 and authenticated non-401 do not notify`() {
        val notifiedTokens = mutableListOf<String>()
        val client = ApiClient(onUnauthorized = notifiedTokens::add)

        client.notifyUnauthorized(statusCode = 401, authorizationToken = null)
        client.notifyUnauthorized(statusCode = 401, authorizationToken = "")
        client.notifyUnauthorized(statusCode = 403, authorizationToken = "valid-token")
        client.notifyUnauthorized(statusCode = 500, authorizationToken = "valid-token")

        assertEquals(emptyList<String>(), notifiedTokens)
    }

    @Test
    fun `unauthorized listener failure does not replace api error`() {
        val client = ApiClient(onUnauthorized = { error("listener failed") })

        val error = withHttpResponse(401) { serverUrl ->
            client.getJson(
                serverUrl = serverUrl,
                path = "/sessions",
                authorizationToken = "expired-token",
            )
        }

        assertApiException(error, 401)
    }

    @Test
    fun `web login host requires a successful html document`() {
        val client = ApiClient()

        val htmlError = withHttpResponse(
            statusCode = 200,
            contentType = "text/html; charset=utf-8",
            body = "<!doctype html><html></html>",
        ) { serverUrl ->
            client.requireHtmlDocument(serverUrl)
        }
        assertEquals(null, htmlError)

        val apiOnlyError = withHttpResponse(
            statusCode = 404,
            contentType = "application/json",
            body = "{\"detail\":\"Not Found\"}",
        ) { serverUrl ->
            client.requireHtmlDocument(serverUrl)
        }
        assertTrue(apiOnlyError is ApiException)
        assertEquals(
            "This address does not host the web login. Enter the Web URL instead of the API URL.",
            apiOnlyError?.message,
        )
    }

    private fun assertApiException(error: Throwable?, statusCode: Int) {
        assertTrue(error is ApiException)
        assertEquals(statusCode, (error as ApiException).statusCode)
    }

    private fun withHttpResponse(
        statusCode: Int,
        observedAuthorization: AtomicReference<String?>? = null,
        request: (serverUrl: String) -> Unit,
    ): Throwable? = withHttpResponse(
        statusCode = statusCode,
        contentType = "application/json",
        body = "{\"detail\":\"invalid user access token\"}",
        observedAuthorization = observedAuthorization,
        request = request,
    )

    private fun withHttpResponse(
        statusCode: Int,
        contentType: String,
        body: String,
        observedAuthorization: AtomicReference<String?>? = null,
        request: (serverUrl: String) -> Unit,
    ): Throwable? {
        val serverFailure = AtomicReference<Throwable?>()
        return ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { serverSocket ->
            val serverThread = thread(name = "api-client-test-server") {
                runCatching {
                    serverSocket.accept().use { socket ->
                        val reader = socket.getInputStream().bufferedReader()
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            if (line.startsWith("Authorization:", ignoreCase = true)) {
                                observedAuthorization?.set(line.substringAfter(':').trim())
                            }
                        }
                        socket.getOutputStream().bufferedWriter().use { writer ->
                            writer.write("HTTP/1.1 $statusCode Unauthorized\r\n")
                            writer.write("Content-Type: $contentType\r\n")
                            writer.write("Content-Length: ${body.toByteArray(Charsets.UTF_8).size}\r\n")
                            writer.write("Connection: close\r\n\r\n")
                            writer.write(body)
                        }
                    }
                }.onFailure(serverFailure::set)
            }

            val result = runCatching {
                request("http://${serverSocket.inetAddress.hostAddress}:${serverSocket.localPort}")
            }
            serverThread.join(2_000)
            assertTrue("Test server did not finish.", !serverThread.isAlive)
            serverFailure.get()?.let { throw AssertionError("Test server failed.", it) }
            result.exceptionOrNull()
        }
    }
}
