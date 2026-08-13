package com.agentsanywhere.app.api

import java.io.BufferedInputStream
import java.net.ServerSocket
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AuthApiTest {
    @Test
    fun oauthTokenUsesIosCompatibleFormContractAndParsesResponse() {
        val request = AtomicReference<CapturedRequest>()
        val server = ServerSocket(0)
        val serverThread = thread(name = "auth-api-test-server") {
            server.accept().use { socket ->
                val input = BufferedInputStream(socket.getInputStream())
                val requestLine = input.readAsciiLine()
                val headers = linkedMapOf<String, String>()
                while (true) {
                    val line = input.readAsciiLine()
                    if (line.isEmpty()) break
                    val name = line.substringBefore(':').trim().lowercase()
                    headers[name] = line.substringAfter(':').trim()
                }
                val length = headers["content-length"]?.toIntOrNull() ?: 0
                val body = ByteArray(length)
                var offset = 0
                while (offset < length) {
                    val count = input.read(body, offset, length - offset)
                    if (count < 0) break
                    offset += count
                }
                request.set(
                    CapturedRequest(
                        method = requestLine.substringBefore(' '),
                        path = requestLine.substringAfter(' ').substringBefore(' '),
                        contentType = headers["content-type"],
                        accept = headers["accept"],
                        form = body.toString(Charsets.UTF_8).decodeForm(),
                    ),
                )
                val response = """{"access_token":"access-token","token_type":"Bearer","expires_in":3600,"scope":"profile"}"""
                    .toByteArray()
                socket.getOutputStream().use { output ->
                    output.write("HTTP/1.1 200 OK\r\n".toByteArray())
                    output.write("Content-Type: application/json\r\n".toByteArray())
                    output.write("Content-Length: ${response.size}\r\n".toByteArray())
                    output.write("Connection: close\r\n\r\n".toByteArray())
                    output.write(response)
                }
            }
        }
        try {
            val token = AuthApi().oauthToken(
                serverUrl = "http://127.0.0.1:${server.localPort}",
                code = "code + slash/",
                codeVerifier = "verifier-value",
            )

            val captured = request.get()
            assertEquals("POST", captured.method)
            assertEquals("/api/v2/oauth/token", captured.path)
            assertTrueFormContentType(captured.contentType)
            assertEquals("application/json", captured.accept)
            assertEquals("authorization_code", captured.form["grant_type"])
            assertEquals("code + slash/", captured.form["code"])
            assertEquals("agents-anywhere-mobile", captured.form["client_id"])
            assertEquals("agents-anywhere://oauth/callback", captured.form["redirect_uri"])
            assertEquals("verifier-value", captured.form["code_verifier"])
            assertEquals("access-token", token.accessToken)
            assertEquals("Bearer", token.tokenType)
            assertEquals(3600, token.expiresIn)
            assertEquals("profile", token.scope)
            assertNull(token.refreshToken)
        } finally {
            server.close()
            serverThread.join(1_000)
        }
    }

    private fun assertTrueFormContentType(contentType: String?) {
        check(contentType?.startsWith("application/x-www-form-urlencoded") == true) {
            "Unexpected Content-Type: $contentType"
        }
    }

    private fun String.decodeForm(): Map<String, String> = split('&').associate { part ->
        URLDecoder.decode(part.substringBefore('='), Charsets.UTF_8.name()) to
            URLDecoder.decode(part.substringAfter('='), Charsets.UTF_8.name())
    }

    private fun BufferedInputStream.readAsciiLine(): String {
        val bytes = ArrayList<Byte>()
        while (true) {
            val value = read()
            if (value < 0 || value == '\n'.code) break
            if (value != '\r'.code) bytes += value.toByte()
        }
        return bytes.toByteArray().toString(Charsets.US_ASCII)
    }

    private data class CapturedRequest(
        val method: String,
        val path: String,
        val contentType: String?,
        val accept: String?,
        val form: Map<String, String>,
    )
}
