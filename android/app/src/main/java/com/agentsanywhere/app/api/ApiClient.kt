package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject
import okhttp3.FormBody
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONException

class ApiClient(
    private val onUnauthorized: (accessToken: String) -> Unit = {},
    private val refreshAccessToken: (serverUrl: String, accessToken: String) -> String? = { _, _ -> null },
) {
    fun requireHtmlDocument(
        serverUrl: String,
        path: String = "/",
    ) {
        try {
            val origin = requireNotNull(normalizeServerOrigin(serverUrl)) {
                "Server URL must be an HTTP(S) origin."
            }
            val normalizedPath = if (path.startsWith('/')) path else "/$path"
            val request = Request.Builder()
                .url("$origin$normalizedPath")
                .header("Accept", "text/html")
                .header("ngrok-skip-browser-warning", "true")
                .get()
                .build()

            JSON_HTTP_CLIENT.newCall(request).execute().use { response ->
                val contentType = response.header("Content-Type").orEmpty()
                if (!response.isSuccessful || !contentType.contains("text/html", ignoreCase = true)) {
                    throw ApiException(
                        message = "The web login is unavailable at $origin. Check the server's web login deployment.",
                        statusCode = response.code,
                    )
                }
            }
        } catch (exc: ApiException) {
            throw exc
        } catch (exc: IllegalArgumentException) {
            throw ApiException("The server URL is invalid.", cause = exc)
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        }
    }

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
        readTimeoutSeconds: Long? = null,
    ): JSONObject {
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "POST",
            bodyText = body.toString(),
            authorizationToken = authorizationToken,
            readTimeoutSeconds = readTimeoutSeconds,
        )
    }

    fun postForm(
        serverUrl: String,
        path: String,
        fields: Map<String, String>,
    ): JSONObject {
        val body = FormBody.Builder().apply {
            fields.forEach { (name, value) -> add(name, value) }
        }.build()
        return requestJson(
            serverUrl = serverUrl,
            path = path,
            method = "POST",
            bodyText = null,
            authorizationToken = null,
            requestBody = body,
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

    fun postMultipart(
        serverUrl: String,
        path: String,
        files: List<UploadFilePart>,
        authorizationToken: String? = null,
        onProgress: ((sent: Long, total: Long) -> Unit)? = null,
    ): JSONObject {
        return withTokenRefresh(serverUrl, authorizationToken) { token ->
            postMultipartOnce(serverUrl, path, files, token, onProgress)
        }
    }

    private fun postMultipartOnce(
        serverUrl: String,
        path: String,
        files: List<UploadFilePart>,
        authorizationToken: String?,
        onProgress: ((sent: Long, total: Long) -> Unit)?,
    ): JSONObject {
        var attempt = 0
        var backoffMs = INITIAL_UPLOAD_BACKOFF_MS
        while (true) {
            attempt += 1
            try {
                return postMultipartRequest(serverUrl, path, files, authorizationToken, onProgress)
            } catch (exc: ApiException) {
                val status = exc.statusCode
                val retryable = status == null || status >= 500
                if (!retryable || attempt >= MAX_UPLOAD_ATTEMPTS) throw exc
                runCatching { Thread.sleep(backoffMs) }
                backoffMs *= 2
            }
        }
    }

    private fun postMultipartRequest(
        serverUrl: String,
        path: String,
        files: List<UploadFilePart>,
        authorizationToken: String?,
        onProgress: ((sent: Long, total: Long) -> Unit)?,
    ): JSONObject {
        val url = apiUrl(serverUrl, path)
        val totalBytes = files.sumOf { part -> part.size.coerceAtLeast(0L) }
        val sentBytes = AtomicLong(0L)
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .apply {
                files.forEach { part ->
                    addFormDataPart(
                        name = "files",
                        filename = part.name.httpQuoted(),
                        body = ProgressRequestBody(part, totalBytes, sentBytes, onProgress),
                    )
                }
            }
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("ngrok-skip-browser-warning", "true")
            .apply {
                if (!authorizationToken.isNullOrBlank()) {
                    header("Authorization", "Bearer $authorizationToken")
                }
            }
            .post(multipart)
            .build()
        return try {
            HttpClientProvider.uploadClient.newCall(request).execute().use { response ->
                val responseText = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw ApiException(
                        message = parseErrorMessage(responseText) ?: defaultErrorMessage(response.code),
                        statusCode = response.code,
                        errorCode = parseErrorCode(responseText),
                    )
                }
                rememberApiUrl(serverUrl, url)
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

    /**
     * Opens a streaming attachment download. Returns null when the server does not
     * expose the streaming endpoint (older builds), so the caller can fall back to
     * the base64 JSON endpoint. The caller owns the response and must close it.
     */
    fun openAttachmentStream(
        serverUrl: String,
        path: String,
        authorizationToken: String?,
    ): okhttp3.Response? {
        val url = apiUrl(serverUrl, path)
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/octet-stream")
            .header("ngrok-skip-browser-warning", "true")
            .apply {
                if (!authorizationToken.isNullOrBlank()) {
                    header("Authorization", "Bearer $authorizationToken")
                }
            }
            .get()
            .build()
        val response = try {
            HttpClientProvider.client.newCall(request).execute()
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        }
        if (response.code == 404 || response.code == 405) {
            response.close()
            return null
        }
        if (!response.isSuccessful) {
            val responseText = runCatching { response.body?.string() }.getOrNull().orEmpty()
            val error = ApiException(
                message = parseErrorMessage(responseText) ?: defaultErrorMessage(response.code),
                statusCode = response.code,
                errorCode = parseErrorCode(responseText),
            )
            response.close()
            throw error
        }
        return response
    }

    private fun requestJson(
        serverUrl: String,
        path: String,
        method: String,
        bodyText: String?,
        authorizationToken: String?,
        readTimeoutSeconds: Long? = null,
        requestBody: RequestBody? = null,
    ): JSONObject {
        return withTokenRefresh(serverUrl, authorizationToken) { token ->
            requestJsonOnce(serverUrl, path, method, bodyText, token, readTimeoutSeconds, requestBody)
        }
    }

    private fun requestJsonOnce(
        serverUrl: String,
        path: String,
        method: String,
        bodyText: String?,
        authorizationToken: String?,
        readTimeoutSeconds: Long?,
        requestBody: RequestBody?,
    ): JSONObject {
        return try {
            val resolvedRequestBody = requestBody ?: when {
                bodyText != null -> bodyText.toRequestBody(JSON_MEDIA_TYPE)
                method == "POST" || method == "PUT" || method == "PATCH" -> EMPTY_JSON_BODY
                else -> null
            }
            val httpClient = if (readTimeoutSeconds == null) {
                JSON_HTTP_CLIENT
            } else {
                JSON_HTTP_CLIENT.newBuilder()
                    .readTimeout(readTimeoutSeconds, TimeUnit.SECONDS)
                    .build()
            }

            val candidates = apiUrlCandidates(serverUrl, path)
            candidates.forEachIndexed { index, url ->
                val request = Request.Builder()
                    .url(url)
                    .header("Accept", "application/json")
                    .header("ngrok-skip-browser-warning", "true")
                    .method(method, resolvedRequestBody)
                    .apply {
                        if (!authorizationToken.isNullOrBlank()) {
                            header("Authorization", "Bearer $authorizationToken")
                        }
                    }
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    val responseText = response.body?.string().orEmpty()
                    val contentType = response.header("Content-Type").orEmpty()
                    val canTryLegacy = index < candidates.lastIndex &&
                        shouldTryLegacyApi(response.code, response.isSuccessful, contentType, responseText)
                    if (canTryLegacy) return@forEachIndexed

                    if (!response.isSuccessful) {
                        throw ApiException(
                            message = parseErrorMessage(responseText) ?: defaultErrorMessage(response.code),
                            statusCode = response.code,
                            errorCode = parseErrorCode(responseText),
                        )
                    }

                    val json = parseJsonResponse(responseText)
                    rememberApiUrl(serverUrl, url)
                    return json
                }
            }
            throw ApiException("The server returned an invalid response.")
        } catch (exc: ApiException) {
            throw exc
        } catch (exc: IllegalArgumentException) {
            throw ApiException("The server URL is invalid.", cause = exc)
        } catch (exc: IOException) {
            throw ApiException("Could not reach the server. Check the URL and network.", cause = exc)
        }
    }

    private fun withTokenRefresh(
        serverUrl: String,
        authorizationToken: String?,
        request: (String?) -> JSONObject,
    ): JSONObject {
        try {
            return request(authorizationToken)
        } catch (exc: ApiException) {
            if (!shouldNotifyUnauthorized(exc.statusCode ?: 0, authorizationToken)) throw exc
            val refreshedToken = refreshAccessToken(serverUrl, authorizationToken.orEmpty())
            if (refreshedToken.isNullOrBlank()) {
                notifyUnauthorized(401, authorizationToken)
                throw exc
            }
            try {
                return request(refreshedToken)
            } catch (retry: ApiException) {
                notifyUnauthorized(retry.statusCode ?: 0, refreshedToken)
                throw retry
            }
        }
    }

    internal fun notifyUnauthorized(statusCode: Int, authorizationToken: String?) {
        if (!shouldNotifyUnauthorized(statusCode, authorizationToken)) return
        runCatching { onUnauthorized(authorizationToken.orEmpty()) }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val EMPTY_JSON_BODY = ByteArray(0).toRequestBody(JSON_MEDIA_TYPE)
        val JSON_HTTP_CLIENT: OkHttpClient = HttpClientProvider.client
        const val MAX_UPLOAD_ATTEMPTS = 3
        const val INITIAL_UPLOAD_BACKOFF_MS = 2_000L
        const val COPY_BUFFER_SIZE = 64L * 1024L
    }

    private fun parseErrorCode(responseText: String): String? = runCatching {
        val body = JSONObject(responseText)
        (body.optJSONObject("detail") ?: body).optString("code").takeIf(String::isNotBlank)
    }.getOrNull()

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

    private fun parseJsonResponse(responseText: String): JSONObject {
        if (responseText.isBlank()) return JSONObject()
        return try {
            JSONObject(responseText)
        } catch (exc: JSONException) {
            throw ApiException("The server returned an invalid response.", cause = exc)
        }
    }

    private fun shouldTryLegacyApi(
        statusCode: Int,
        successful: Boolean,
        contentType: String,
        responseText: String,
    ): Boolean {
        if (statusCode == 405) return true
        if (contentType.isJsonContentType()) return false
        if (statusCode == 404) return true
        val looksLikeHtml = contentType.contains("text/html", ignoreCase = true) ||
            responseText.trimStart().startsWith("<!DOCTYPE", ignoreCase = true) ||
            responseText.trimStart().startsWith("<html", ignoreCase = true)
        return successful && looksLikeHtml
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

    private fun String.isJsonContentType(): Boolean {
        return contains("application/json", ignoreCase = true) ||
            contains("+json", ignoreCase = true)
    }
}

internal fun shouldNotifyUnauthorized(statusCode: Int, authorizationToken: String?): Boolean {
    return statusCode == 401 && !authorizationToken.isNullOrBlank()
}

data class UploadFilePart(
    val name: String,
    val mediaType: String,
    val file: File,
    val size: Long = file.length(),
)

private class ProgressRequestBody(
    private val part: UploadFilePart,
    private val totalBytes: Long,
    private val sentBytes: AtomicLong,
    private val onProgress: ((sent: Long, total: Long) -> Unit)?,
) : RequestBody() {
    override fun contentType(): MediaType? =
        part.mediaType.ifBlank { "application/octet-stream" }.toMediaTypeOrNull()

    override fun contentLength(): Long = part.file.length()

    override fun writeTo(sink: BufferedSink) {
        part.file.source().use { source ->
            val buffer = Buffer()
            while (true) {
                val read = source.read(buffer, 64L * 1024L)
                if (read == -1L) break
                sink.write(buffer, read)
                onProgress?.invoke(sentBytes.addAndGet(read), totalBytes)
            }
        }
    }
}

class ApiException(
    override val message: String,
    val statusCode: Int? = null,
    cause: Throwable? = null,
    val errorCode: String? = null,
) : Exception(message, cause)
