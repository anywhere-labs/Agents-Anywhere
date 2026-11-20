package dev.agentsanywhere.v3poc.model

import dev.agentsanywhere.v3poc.BuildConfig
import dev.agentsanywhere.v3poc.generated.ContentClient
import dev.agentsanywhere.v3poc.generated.ContentEvent
import dev.agentsanywhere.v3poc.generated.ContentPairRequest
import dev.agentsanywhere.v3poc.generated.ContentPairResult
import dev.agentsanywhere.v3poc.generated.ContentRequest
import dev.agentsanywhere.v3poc.generated.ContentResult
import dev.agentsanywhere.v3poc.generated.ContentSubscribeRequest
import dev.agentsanywhere.v3poc.generated.MobileControlClient
import io.github.t4wefan.meshcall.CallOptions
import io.github.t4wefan.meshcall.Mesh
import io.github.t4wefan.meshcall.MeshCallException
import io.github.t4wefan.meshcall.MeshOptions
import io.github.t4wefan.meshcall.Router
import io.github.t4wefan.meshcall.RetryPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
class DeviceTunnelGrant(
    @SerialName("router_url") val routerUrl: String,
    @SerialName("instance_id") val instanceId: String,
    val credential: String,
    @SerialName("e2e_key") val e2eKey: String,
    val maxFrameBytes: Int,
)

internal class ClientNoLongerAuthorized : IllegalStateException()

class ContentAuthorization(val clientId: String, val credential: String) {
    internal fun options() = CallOptions.DEFAULT.withMetadata(
        mapOf("aa-content-client" to clientId, "aa-content-credential" to credential),
    )
}

/** Scoped to a native client's locally verified device identity. */
class DeviceContentTransport(
    private val instanceId: String,
    private val pinnedKey: String,
    private val issue: suspend () -> DeviceTunnelGrant,
) {
    constructor(
        server: HttpUrl,
        instanceId: String,
        pinnedKey: String,
        http: OkHttpClient,
        accessToken: suspend () -> String,
    ) : this(instanceId, pinnedKey, {
        val grant = withMobileControl(server, http, accessToken) { client, instance ->
            client.issueContentTunnel(instance = instance, deviceId = instanceId)
        }
        if (grant.maxFrameBytes !in 1L..Int.MAX_VALUE.toLong()) throw DeviceGrantUnavailable()
        DeviceTunnelGrant(
            routerUrl = grant.routerUrl, instanceId = grant.instanceId, credential = grant.credential,
            e2eKey = grant.e2eKey, maxFrameBytes = grant.maxFrameBytes.toInt(),
        )
    })

    private val lock = Mutex()
    private var current: Mesh? = null

    suspend fun pair(request: ContentPairRequest): ContentPairResult = try {
        ContentClient(connect()).pair(
            instanceId, request.clientIdentityPub, request.clientSecret, request.label,
            request.pairingId, request.pairingSecret, request.platform,
        )
    } catch (error: MeshCallException) {
        if (error.reason == "pairing_expired") throw PairingInvitationExpired()
        throw error
    }

    suspend fun request(request: ContentRequest, authorization: ContentAuthorization): ContentResult = try {
        ContentClient(connect()).request(instanceId, request.body, request.method, request.path, authorization.options())
    } catch (error: MeshCallException) {
        if (error.reason == "e2ee_not_paired") throw ClientNoLongerAuthorized()
        throw error
    }

    fun subscribe(request: ContentSubscribeRequest, authorization: ContentAuthorization): Flow<ContentEvent> = flow {
        emitAll(ContentClient(connect()).subscribe(
            instanceId, request.afterCursor, request.fromSeq, request.sessionId.orEmpty(), request.stream ?: "session",
            request.terminalId, authorization.options(),
        ))
    }

    suspend fun invalidate() = lock.withLock {
        current?.close()
        current = null
    }

    private suspend fun connect(): Mesh = lock.withLock {
        current?.let { return it }
        val grant = issue()
        if (grant.instanceId != instanceId || pinnedKey.isBlank() || grant.e2eKey != pinnedKey ||
            !grant.credential.startsWith("mtun_e2e.") || !safeRouter(grant.routerUrl)) {
            throw DeviceIdentityMismatch()
        }
        Mesh(Router(grant.routerUrl), MeshOptions(
            tunnel = grant.credential, e2eKey = pinnedKey, maxFrameSize = grant.maxFrameBytes,
            retry = RetryPolicy(enabled = false),
        )).also { current = it }
    }
}

class DeviceIdentityMismatch : IllegalStateException()
class DeviceGrantUnavailable : IllegalStateException()


private fun safeRouter(address: String): Boolean {
    val url = runCatching { java.net.URI(address) }.getOrNull() ?: return false
    return url.host != null && url.userInfo == null &&
        (url.scheme == "wss" || (BuildConfig.DEBUG && url.scheme == "ws" &&
            url.host in setOf("127.0.0.1", "localhost", "[::1]")))
}


internal suspend fun <T> withMobileControl(
    server: HttpUrl, http: OkHttpClient, accessToken: suspend () -> String,
    call: suspend (MobileControlClient, String) -> T,
): T {
    val endpoint = server.newBuilder().addPathSegments("api/v3/mobile/control-tunnel").build()
    val request = Request.Builder().url(endpoint)
        .header("Authorization", "Bearer ${accessToken()}")
        .post(ByteArray(0).toRequestBody())
        .build()
    val bootstrap = withContext(Dispatchers.IO) {
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw AccountRequestFailed(response.code)
            AAJson.decodeFromString(DeviceTunnelGrant.serializer(), response.body.string())
        }
    }
    if (!bootstrap.credential.startsWith("mtun_e2e.") || bootstrap.e2eKey.isBlank() || !safeRouter(bootstrap.routerUrl)) {
        throw DeviceGrantUnavailable()
    }
    val control = Mesh(Router(bootstrap.routerUrl), MeshOptions(
        tunnel = bootstrap.credential, e2eKey = bootstrap.e2eKey, maxFrameSize = bootstrap.maxFrameBytes,
        retry = RetryPolicy(enabled = false),
    ))
    try {
        return call(MobileControlClient(control), bootstrap.instanceId)
    } finally {
        control.close()
    }
}
