package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.generated.ContentClient
import com.agentsanywhere.app.api.e2ee.generated.ContentPairRequest
import com.agentsanywhere.app.api.e2ee.generated.ContentPairResult
import com.agentsanywhere.app.api.e2ee.generated.MobileControlClient
import io.github.t4wefan.meshcall.CallOptions
import io.github.t4wefan.meshcall.Mesh
import io.github.t4wefan.meshcall.MeshCallException
import io.github.t4wefan.meshcall.MeshOptions
import io.github.t4wefan.meshcall.Router
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import org.json.JSONObject
import org.json.JSONTokener

interface DeviceContentChannel {
    val deviceId: String
    val clientId: String
    val ready: ChannelReady?
    val isOpen: Boolean
    fun onChannelEvent(listener: (JSONObject) -> Unit): () -> Unit
    fun onClose(listener: (ChannelClosedException) -> Unit)
    suspend fun request(method: String, path: String, bodyJson: String? = null): TunnelResponse
    fun subscribe(sessionId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): String
    fun subscribeTerminal(terminalId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): String
    fun unsubscribe(id: String)
    fun close()
}

/** A content channel authenticated by the device, independent of the Server's routing grant. */
internal class MeshDeviceChannel private constructor(
    private val mesh: Mesh,
    override val deviceId: String,
    override val clientId: String,
    secret: String,
) : DeviceContentChannel {
    private val client = ContentClient(mesh)
    private val options = CallOptions.DEFAULT.withMetadata(
        mapOf("aa-content-client" to clientId, "aa-content-credential" to secret),
    )
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val subscriptions = ConcurrentHashMap<String, Job>()
    private val sequence = AtomicLong()
    private val closed = AtomicBoolean()
    private val closeListeners = ConcurrentHashMap.newKeySet<(ChannelClosedException) -> Unit>()
    private val eventListeners = ConcurrentHashMap.newKeySet<(JSONObject) -> Unit>()
    override val isOpen: Boolean get() = !closed.get()
    override val ready: ChannelReady? get() = null

    suspend fun pair(request: ContentPairRequest): ContentPairResult = rpc {
        client.pair(deviceId, request.clientIdentityPub, request.clientSecret, request.label,
            request.pairingId, request.pairingSecret, request.platform)
    }

    override suspend fun request(method: String, path: String, bodyJson: String?): TunnelResponse {
        if (!isOpen) throw ChannelClosedException("closed")
        return rpc {
            val result = client.request(deviceId, bodyJson?.let(json::parseToJsonElement), method, path, options)
            val body = result.body?.takeUnless { it is JsonNull }?.let {
                JSONTokener(it.toString()).nextValue().takeUnless { value -> value == JSONObject.NULL }
            }
            TunnelResponse(result.status.toInt(), body)
        }
    }

    override fun subscribe(sessionId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): String =
        subscribe("session", sessionId, null, afterCursor, onEvent)

    override fun subscribeTerminal(terminalId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): String =
        subscribe("terminal", "", terminalId, afterCursor, onEvent)

    fun watchTrust() {
        subscribe("trust", "", null, null) { event -> eventListeners.forEach { it(event) } }
    }

    private fun subscribe(stream: String, sessionId: String, terminalId: String?, cursor: String?, onEvent: (JSONObject) -> Unit): String {
        if (!isOpen) throw ChannelClosedException("closed")
        val id = sequence.incrementAndGet().toString()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val fromSeq = cursor?.toLongOrNull()?.takeIf { stream == "terminal" }
                client.subscribe(deviceId, cursor, fromSeq, sessionId, stream, terminalId, options).collect {
                    onEvent(JSONObject(it.toString()))
                }
                finish(ChannelClosedException("connection_lost"))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: MeshCallException) {
                finish(channelError(error))
            } catch (_: Exception) {
                finish(ChannelClosedException("e2ee_protocol_error"))
            } finally {
                subscriptions.remove(id)
            }
        }
        subscriptions[id] = job
        job.start()
        return id
    }

    override fun unsubscribe(id: String) {
        subscriptions.remove(id)?.cancel()
    }

    override fun onChannelEvent(listener: (JSONObject) -> Unit): () -> Unit {
        eventListeners.add(listener)
        return { eventListeners.remove(listener) }
    }

    override fun onClose(listener: (ChannelClosedException) -> Unit) {
        closeListeners.add(listener)
        if (!isOpen && closeListeners.remove(listener)) listener(ChannelClosedException("closed"))
    }

    override fun close() = finish(ChannelClosedException("closed"))

    private fun finish(error: ChannelClosedException) {
        if (!closed.compareAndSet(false, true)) return
        scope.cancel()
        subscriptions.clear()
        mesh.close()
        closeListeners.forEach { listener -> if (closeListeners.remove(listener)) listener(error) }
        eventListeners.clear()
    }

    private suspend fun <T> rpc(block: suspend () -> T): T = try {
        block()
    } catch (error: MeshCallException) {
        val failure = channelError(error)
        finish(failure)
        throw failure
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        private fun channelError(error: MeshCallException): ChannelClosedException =
            ChannelClosedException(error.reason ?: error.code, error.message ?: error.code)

        suspend fun open(
            bootstrap: JSONObject, deviceId: String, pin: String, clientId: String, secret: String,
        ): MeshDeviceChannel {
            val grant = json.decodeFromString(ControlTunnelGrant.serializer(), bootstrap.toString())
            val control = mesh(grant.routerUrl, grant.credential, grant.e2eKey, grant.maxFrameBytes)
            val issued = try {
                MobileControlClient(control).issueContentTunnel(instance = grant.instanceId, deviceId = deviceId)
            } catch (error: MeshCallException) {
                throw channelError(error)
            } finally {
                control.close()
            }
            if (issued.instanceId != deviceId || issued.e2eKey != pin)
                throw ChannelClosedException(E2eeErrorCodes.DEVICE_PIN_MISMATCH)
            return MeshDeviceChannel(mesh(issued.routerUrl, issued.credential, pin, issued.maxFrameBytes), deviceId, clientId, secret)
        }

        private fun mesh(url: String, credential: String, key: String, maxBytes: Long): Mesh {
            if (!credential.startsWith("mtun_e2e.") || key.isBlank() || maxBytes !in 1..Int.MAX_VALUE.toLong())
                throw ChannelClosedException(E2eeErrorCodes.E2EE_REQUIRED)
            return Mesh(Router(url), MeshOptions(tunnel = credential, e2eKey = key, maxFrameSize = maxBytes.toInt()))
        }
    }
}

@Serializable
private data class ControlTunnelGrant(
    @SerialName("router_url") val routerUrl: String,
    @SerialName("instance_id") val instanceId: String,
    @SerialName("e2e_key") val e2eKey: String,
    val credential: String,
    val maxFrameBytes: Long,
)
