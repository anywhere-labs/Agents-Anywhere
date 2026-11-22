package dev.agentsanywhere.v3.core.api

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.model.ApiErrorBody
import dev.agentsanywhere.v3.core.model.AuthConfig
import dev.agentsanywhere.v3.core.model.AuthTokenResponse
import dev.agentsanywhere.v3.core.model.LoginRequest
import dev.agentsanywhere.v3.core.model.RefreshRequest
import dev.agentsanywhere.v3.core.model.RouterTokenRequest
import dev.agentsanywhere.v3.core.model.RouterTokenResponse
import dev.agentsanywhere.v3.core.model.UserView
import dev.agentsanywhere.v3.core.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonArray
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A control plane HTTP error (`{"code", "detail"}`) or a transport failure (`status == 0`, code `network`). */
class ApiException(val status: Int, val code: String, message: String) : Exception(message) {
    val unauthenticated: Boolean get() = status == 401 || code == "unauthenticated"
}

/**
 * The control plane's HTTP API (server-v3/aa_control/api): sign-in and the short-lived MeshCall Router token.
 * Everything else goes through MeshCall (`aa.v3.Control`).
 */
class ControlHttpClient(
    baseUrl: String,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    val baseUrl: String = normalizeBaseUrl(baseUrl)

    suspend fun config(): AuthConfig = get("/auth/config", AuthConfig.serializer())

    suspend fun login(email: String, password: String, clientId: String): AuthTokenResponse =
        post("/auth/login", LoginRequest(email.trim(), password, clientId), LoginRequest.serializer(), AuthTokenResponse.serializer())

    suspend fun refresh(refreshToken: String): AuthTokenResponse =
        post("/auth/refresh", RefreshRequest(refreshToken), RefreshRequest.serializer(), AuthTokenResponse.serializer())

    suspend fun logout(refreshToken: String) {
        runCatching { post("/auth/logout", RefreshRequest(refreshToken), RefreshRequest.serializer(), kotlinx.serialization.json.JsonObject.serializer()) }
    }

    suspend fun me(accessToken: String): UserView = get("/auth/me", UserView.serializer(), accessToken)

    suspend fun routerToken(accessToken: String, clientId: String): RouterTokenResponse =
        post("/auth/router-token", RouterTokenRequest(clientId), RouterTokenRequest.serializer(), RouterTokenResponse.serializer(), accessToken)

    private suspend fun <T> get(path: String, out: DeserializationStrategy<T>, bearer: String? = null): T =
        execute(Request.Builder().url(baseUrl + path).get(), out, bearer)

    private suspend fun <I, T> post(path: String, body: I, inSer: SerializationStrategy<I>, out: DeserializationStrategy<T>, bearer: String? = null): T =
        execute(Request.Builder().url(baseUrl + path).post(AAJson.encodeToString(inSer, body).toRequestBody(JSON)), out, bearer)

    private suspend fun <T> execute(builder: Request.Builder, out: DeserializationStrategy<T>, bearer: String?): T = withContext(Dispatchers.IO) {
        bearer?.let { builder.header("Authorization", "Bearer $it") }
        builder.header("Accept", "application/json")
        val response = try {
            http.newCall(builder.build()).execute()
        } catch (e: IOException) {
            throw ApiException(0, "network", e.message ?: "network error")
        }
        response.use {
            val text = it.body.string()
            if (!it.isSuccessful) throw parseError(it.code, text)
            try {
                AAJson.decodeFromString(out, text)
            } catch (e: Exception) {
                throw ApiException(it.code, "invalid_response", "Unexpected response from the control plane: ${e.message}")
            }
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        /** "control.example.com" → "https://control.example.com"; trailing slashes dropped. */
        fun normalizeBaseUrl(raw: String): String {
            var url = raw.trim().trimEnd('/')
            if (!url.contains("://")) url = (if (url.startsWith("127.") || url.startsWith("localhost") || url.startsWith("10.")) "http://" else "https://") + url
            require(url.toHttpUrlOrNull() != null) { "Not a valid URL: $raw" }
            return url
        }

        internal fun parseError(status: Int, text: String): ApiException {
            val body = runCatching { AAJson.decodeFromString(ApiErrorBody.serializer(), text) }.getOrNull()
            val detail = when (val d = body?.detail) {
                null -> null
                is JsonArray -> d.joinToString("; ") { it["msg"].str ?: it.toString() }
                else -> d.str ?: d.toString()
            }
            val code = body?.code ?: when (status) {
                401 -> "unauthenticated"
                403 -> "permission_denied"
                404 -> "not_found"
                422 -> "invalid_argument"
                429 -> "resource_exhausted"
                else -> "http_$status"
            }
            return ApiException(status, code, detail ?: "HTTP $status")
        }

        private operator fun kotlinx.serialization.json.JsonElement.get(key: String) = (this as? kotlinx.serialization.json.JsonObject)?.get(key)
    }
}
