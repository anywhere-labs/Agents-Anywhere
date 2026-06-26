package com.agentsanywhere.app.api

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiClient {
    fun getJson(
        serverUrl: String,
        path: String,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "GET",
            body = null,
            authorizationToken = authorizationToken,
        )
    }

    fun postJson(
        serverUrl: String,
        path: String,
        body: JSONObject,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "POST",
            body = body,
            authorizationToken = authorizationToken,
        )
    }

    fun patchJson(
        serverUrl: String,
        path: String,
        body: JSONObject,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "PATCH",
            body = body,
            authorizationToken = authorizationToken,
        )
    }

    fun putJson(
        serverUrl: String,
        path: String,
        body: JSONObject,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "PUT",
            body = body,
            authorizationToken = authorizationToken,
        )
    }

    fun deleteJson(
        serverUrl: String,
        path: String,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "DELETE",
            body = null,
            authorizationToken = authorizationToken,
        )
    }

    fun streamSse(
        serverUrl: String,
        path: String,
        onOpen: () -> Unit = {},
        onEvent: (JSONObject) -> Unit,
    ) {
        val endpoint = URL("${serverUrl.trimEnd('/')}$path")
        val connection = (endpoint.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 35_000
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("Cache-Control", "no-cache")
            setRequestProperty("ngrok-skip-browser-warning", "true")
        }
        try {
            val responseCode = connection.responseCode
            if (responseCode !in 200..299) {
                val responseText = readResponseText(connection, responseCode)
                throw ApiException(
                    message = parseErrorMessage(responseText) ?: defaultErrorMessage(responseCode),
                    statusCode = responseCode,
                )
            }
            onOpen()
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val data = StringBuilder()
                while (!Thread.currentThread().isInterrupted) {
                    val line = reader.readLine() ?: break
                    when {
                        line.isEmpty() -> {
                            if (data.isNotEmpty()) {
                                onEvent(JSONObject(data.toString()))
                                data.clear()
                            }
                        }
                        line.startsWith("data:") -> {
                            if (data.isNotEmpty()) data.append('\n')
                            data.append(line.removePrefix("data:").trimStart())
                        }
                    }
                }
            }
        } catch (exc: ApiException) {
            throw exc
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        } finally {
            connection.disconnect()
        }
    }

    fun postMultipart(
        serverUrl: String,
        path: String,
        files: List<UploadFilePart>,
        authorizationToken: String? = null,
    ): JSONObject {
        return try {
            val endpoint = URL("${serverUrl.trimEnd('/')}$path")
            val boundary = "AA-${System.currentTimeMillis()}"
            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 60_000
                doOutput = true
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                setRequestProperty("ngrok-skip-browser-warning", "true")
                if (!authorizationToken.isNullOrBlank()) {
                    setRequestProperty("Authorization", "Bearer $authorizationToken")
                }
            }
            try {
                connection.outputStream.use { output ->
                    files.forEach { file ->
                        output.write("--$boundary\r\n".toByteArray(Charsets.UTF_8))
                        output.write(
                            "Content-Disposition: form-data; name=\"files\"; filename=\"${file.name.httpQuoted()}\"\r\n"
                                .toByteArray(Charsets.UTF_8),
                        )
                        output.write("Content-Type: ${file.mediaType.ifBlank { "application/octet-stream" }}\r\n\r\n".toByteArray(Charsets.UTF_8))
                        output.write(file.bytes)
                        output.write("\r\n".toByteArray(Charsets.UTF_8))
                    }
                    output.write("--$boundary--\r\n".toByteArray(Charsets.UTF_8))
                }
                val responseCode = connection.responseCode
                val responseText = readResponseText(connection, responseCode)
                if (responseCode !in 200..299) {
                    throw ApiException(
                        message = parseErrorMessage(responseText) ?: defaultErrorMessage(responseCode),
                        statusCode = responseCode,
                    )
                }
                if (responseText.isBlank()) JSONObject() else JSONObject(responseText)
            } finally {
                connection.disconnect()
            }
        } catch (exc: ApiException) {
            throw exc
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        }
    }

    private fun requestJson(
        serverUrl: String,
        path: String,
        method: String,
        body: JSONObject?,
        authorizationToken: String?,
    ): JSONObject {
        return try {
            val endpoint = URL("${serverUrl.trimEnd('/')}$path")
            val bodyText = body?.toString()

            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 15_000
                doOutput = bodyText != null
                setRequestProperty("Accept", "application/json")
                setRequestProperty("ngrok-skip-browser-warning", "true")
                if (bodyText != null) {
                    setRequestProperty("Content-Type", "application/json")
                }
                if (!authorizationToken.isNullOrBlank()) {
                    setRequestProperty("Authorization", "Bearer $authorizationToken")
                }
            }

            try {
                if (bodyText != null) {
                    connection.outputStream.use { output ->
                        output.write(bodyText.toByteArray(Charsets.UTF_8))
                    }
                }

                val responseCode = connection.responseCode
                val responseText = readResponseText(connection, responseCode)
                if (responseCode !in 200..299) {
                    throw ApiException(
                        message = parseErrorMessage(responseText) ?: defaultErrorMessage(responseCode),
                        statusCode = responseCode,
                    )
                }

                if (responseText.isBlank()) JSONObject() else JSONObject(responseText)
            } finally {
                connection.disconnect()
            }
        } catch (exc: ApiException) {
            throw exc
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        }
    }

    private fun readResponseText(connection: HttpURLConnection, responseCode: Int): String {
        val stream = if (responseCode in 200..299) {
            connection.inputStream
        } else {
            connection.errorStream
        }
        return stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
    }

    private fun parseErrorMessage(responseText: String): String? {
        return runCatching {
            val detail = JSONObject(responseText).opt("detail")
            when (detail) {
                is String -> detail.takeIf { it.isNotBlank() }
                is JSONObject -> detail.optString("message")
                    .ifBlank { detail.optString("code") }
                    .takeIf { it.isNotBlank() }
                else -> detail?.toString()?.takeIf { it.isNotBlank() }
            }
        }.getOrNull()
    }

    private fun defaultErrorMessage(statusCode: Int): String {
        return when (statusCode) {
            401 -> "Unauthorized request."
            404 -> "Endpoint was not found on this server."
            else -> "Request failed with status $statusCode."
        }
    }

    private fun String.httpQuoted(): String {
        return replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", "").replace("\n", "")
    }
}

data class UploadFilePart(
    val name: String,
    val mediaType: String,
    val bytes: ByteArray,
)

class ApiException(
    override val message: String,
    val statusCode: Int? = null,
    cause: Throwable? = null,
) : Exception(message, cause)
