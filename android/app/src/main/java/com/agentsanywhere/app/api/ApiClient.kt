package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

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
            bodyText = null,
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
            bodyText = body.toString(),
            authorizationToken = authorizationToken,
        )
    }

    fun postJson(
        serverUrl: String,
        path: String,
        body: JSONArray,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "POST",
            bodyText = body.toString(),
            authorizationToken = authorizationToken,
        )
    }

    fun postJson(
        serverUrl: String,
        path: String,
        authorizationToken: String? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "POST",
            bodyText = null,
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
            bodyText = body.toString(),
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
            bodyText = body.toString(),
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
            bodyText = null,
            authorizationToken = authorizationToken,
        )
    }

    fun streamSse(
        serverUrl: String,
        path: String,
        onOpen: () -> Unit = {},
        onEvent: (JSONObject) -> Unit,
    ) {
        val endpoint = URL(apiUrl(serverUrl, path))
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
            val endpoint = URL(apiUrl(serverUrl, path))
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
        bodyText: String?,
        authorizationToken: String?,
    ): JSONObject {
        return try {
            val requestBody = when {
                bodyText != null -> bodyText.toRequestBody(JSON_MEDIA_TYPE)
                method == "POST" || method == "PUT" || method == "PATCH" -> EMPTY_JSON_BODY
                else -> null
            }
            val request = Request.Builder()
                .url(apiUrl(serverUrl, path))
                .header("Accept", "application/json")
                .header("ngrok-skip-browser-warning", "true")
                .method(method, requestBody)
                .apply {
                    if (!authorizationToken.isNullOrBlank()) {
                        header("Authorization", "Bearer $authorizationToken")
                    }
                }
                .build()

            JSON_HTTP_CLIENT.newCall(request).execute().use { response ->
                val responseText = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw ApiException(
                        message = parseErrorMessage(responseText) ?: defaultErrorMessage(response.code),
                        statusCode = response.code,
                    )
                }
                if (responseText.isBlank()) JSONObject() else JSONObject(responseText)
            }
        } catch (exc: ApiException) {
            throw exc
        } catch (exc: IllegalArgumentException) {
            throw ApiException("The server URL is invalid.", cause = exc)
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val EMPTY_JSON_BODY = ByteArray(0).toRequestBody(JSON_MEDIA_TYPE)
        val JSON_HTTP_CLIENT: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
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
                is JSONArray -> detail.optJSONObject(0)
                    ?.optString("msg")
                    ?.takeIf { it.isNotBlank() }
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
