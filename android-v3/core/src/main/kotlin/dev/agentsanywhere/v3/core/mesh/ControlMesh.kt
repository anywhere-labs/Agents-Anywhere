package dev.agentsanywhere.v3.core.mesh

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.api.AuthSession
import dev.agentsanywhere.v3.core.model.DeviceList
import dev.agentsanywhere.v3.core.model.DeviceRecord
import dev.agentsanywhere.v3.core.model.DeviceSessionResult
import dev.agentsanywhere.v3.core.model.DevicesEvent
import dev.agentsanywhere.v3.core.model.ListSessionsRequest
import dev.agentsanywhere.v3.core.model.OpenTunnelRequest
import dev.agentsanywhere.v3.core.model.OpenTunnelResponse
import dev.agentsanywhere.v3.core.model.RawDevicesEvent
import io.github.t4wefan.meshcall.Mesh
import io.github.t4wefan.meshcall.MeshOptions
import io.github.t4wefan.meshcall.Router
import io.github.t4wefan.meshcall.UnauthenticatedException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import java.time.Instant

/** An app-level failure with a stable code (pairing and tunnel errors from contracts/aa-v3/1.0/pairing.schema.json). */
class AAException(val code: String, message: String) : Exception(message)

/** `http(s)://` → `ws(s)://`; WebSocket URLs pass through. */
fun toWebSocketUrl(url: String): String = when {
    url.startsWith("https://") -> "wss://" + url.removePrefix("https://")
    url.startsWith("http://") -> "ws://" + url.removePrefix("http://")
    else -> url
}

/**
 * `aa.v3.Control` over the MeshCall Router, authenticated with a client Router token (`POST /auth/router-token`).
 * The token lives four hours and dies with a Router restart: the Mesh is rebuilt when it is about to expire, and a
 * call refused as unauthenticated gets a fresh token and is retried once (a stream only if it yielded nothing yet).
 */
class ControlMesh(
    private val auth: AuthSession,
    private val httpClient: OkHttpClient? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private var mesh: Mesh? = null
    private var expiresAt = 0L

    suspend fun mesh(): Mesh = mutex.withLock {
        mesh?.takeIf { expiresAt - clock() > 60_000 }?.let { return it }
        mesh?.close()
        val response = auth.authorized { http, token -> http.routerToken(token, auth.identity.client_id) }
        val entry = response.tokens.firstOrNull() ?: throw AAException("unavailable", "The control plane returned no Router")
        val next = Mesh(Router(toWebSocketUrl(entry.router_url)), MeshOptions(token = entry.token, httpClient = httpClient))
        mesh = next
        expiresAt = runCatching { Instant.parse(entry.expires_at).toEpochMilli() }.getOrDefault(clock() + 3_600_000)
        next
    }

    /** Forget the current token (signed out, or the Router refused it). */
    suspend fun invalidate() = mutex.withLock {
        mesh?.close()
        mesh = null
        expiresAt = 0
    }

    suspend fun <Req, Res> unary(method: String, request: Req, req: SerializationStrategy<Req>, res: DeserializationStrategy<Res>): Res {
        val body = AAJson.encodeToJsonElement(req, request)
        val raw = try {
            mesh().unary(SERVICE, method, body)
        } catch (e: UnauthenticatedException) {
            invalidate()
            mesh().unary(SERVICE, method, body)
        }
        return AAJson.decodeFromJsonElement(res, raw)
    }

    fun stream(method: String, request: JsonElement): Flow<JsonElement> = flow {
        var emitted = false
        try {
            mesh().serverStream(SERVICE, method, request).collect { emitted = true; emit(it) }
        } catch (e: UnauthenticatedException) {
            if (emitted) throw e
            invalidate()
            mesh().serverStream(SERVICE, method, request).collect { emit(it) }
        }
    }

    suspend fun listDevices(): List<DeviceRecord> =
        unary("list_devices", emptyMap(), mapSer, DeviceList.serializer()).devices

    fun watchDevices(): Flow<DevicesEvent> = stream("watch_devices", AAJson.encodeToJsonElement(mapSer, emptyMap())).mapNotNull { raw ->
        val e = runCatching { AAJson.decodeFromJsonElement(RawDevicesEvent.serializer(), raw) }.getOrNull() ?: return@mapNotNull null
        when (e.type) {
            "snapshot" -> DevicesEvent.Snapshot(e.devices.orEmpty())
            "upsert" -> e.device?.let { DevicesEvent.Upsert(it) }
            "remove" -> e.device_id?.let { DevicesEvent.Remove(it) }
            else -> null
        }
    }

    fun listSessions(deviceIds: List<String>? = null, limitPerDevice: Int? = null): Flow<DeviceSessionResult> =
        stream("list_sessions", AAJson.encodeToJsonElement(ListSessionsRequest.serializer(), ListSessionsRequest(deviceIds, limitPerDevice)))
            .mapNotNull { runCatching { AAJson.decodeFromJsonElement(DeviceSessionResult.serializer(), it) }.getOrNull() }

    suspend fun openTunnel(deviceId: String, e2eKey: String?): OpenTunnelResponse =
        unary("open_tunnel", OpenTunnelRequest(deviceId, auth.identity.client_id, e2eKey), OpenTunnelRequest.serializer(), OpenTunnelResponse.serializer())

    suspend fun rename(deviceId: String, name: String): DeviceRecord =
        unary("rename_device", mapOf("device_id" to deviceId, "name" to name), mapSer, DeviceRecord.serializer())

    suspend fun registerPushToken(platform: String = "android", token: String?, label: String?) {
        unary("register_client_push_token",
            buildMap { put("client_id", auth.identity.client_id); put("platform", platform); token?.let { put("push_token", it) }; label?.let { put("label", it) } },
            mapSer, kotlinx.serialization.json.JsonObject.serializer())
    }

    companion object {
        const val SERVICE = "aa.v3.Control"
        private val mapSer = MapSerializer(String.serializer(), String.serializer())
    }
}
