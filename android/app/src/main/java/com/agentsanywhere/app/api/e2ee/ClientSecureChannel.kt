package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.noise.NoiseException
import com.agentsanywhere.app.api.e2ee.noise.NoiseHandshake
import com.agentsanywhere.app.api.e2ee.noise.NoiseKeyPair
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/** 设备发来的列表密钥（`DirectoryKeyGrant`）。`key` 是 base64url 的 32 字节。 */
data class DirectoryKeyGrant(
    val deviceId: String,
    val keyId: String,
    val epoch: Long,
    val key: String,
) {
    val keyBytes: ByteArray get() = E2eeFormats.fromB64url(key)

    companion object {
        fun parse(json: JSONObject?): DirectoryKeyGrant {
            if (json == null) throw ChannelProtocolException("missing directory key")
            val grant = DirectoryKeyGrant(
                deviceId = json.optString("deviceId"),
                keyId = json.optString("keyId"),
                epoch = json.optLong("epoch", -1),
                key = json.optString("key"),
            )
            val keyOk = runCatching { grant.keyBytes.size == 32 }.getOrDefault(false)
            if (grant.deviceId.isEmpty() || grant.keyId.isEmpty() || grant.epoch < 0 || !keyOk) {
                throw ChannelProtocolException("malformed directory key")
            }
            return grant
        }
    }
}

data class ChannelReady(
    val deviceId: String,
    val clientId: String,
    val directoryKeyId: String,
    val directoryKeyEpoch: Long,
)

/** `TunnelResponse`：`body` 是 [JSONObject]、[JSONArray]、基本类型或 null。 */
data class TunnelResponse(val status: Int, val body: Any?) {
    val isSuccessful: Boolean get() = status in 200..299
    fun bodyObject(): JSONObject? = body as? JSONObject
}

data class PairResult(
    val channel: ClientSecureChannel,
    val grantedAt: String,
    val directoryKey: DirectoryKeyGrant,
)

/**
 * 通道失败或已关闭；`code` 是 AA 错误码（`e2ee_not_paired`、`pairing_expired`、`device_pin_mismatch`…）。
 *
 * [fromDevice] 为 true 只表示设备在已认证的通道里发了 `close`；Server 转来的 `ClientTunnelEnd.code`、
 * 本地判断出的错误都是 false。Server 能伪造前者以外的一切，所以只有 `fromDevice` 的撤销才能改动信任记录。
 */
class ChannelClosedException(
    val code: String,
    message: String = code,
    val fromDevice: Boolean = false,
) : Exception(message)

/**
 * 客户端安全通道（移植自 connector-ts/src/channel/client-channel.ts）。
 *
 * - 配对：`XXpsk0`，核对握手里的设备静态公钥与二维码一致，收到 `pair.committed` 后返回授权与列表密钥；
 * - 重连：`KK`，设备公钥是钉住的值；
 * - 收到 `ready` 之前不发任何请求。
 *
 * 线程：[receive] / [ended] 可在任意线程调用（通常是 WebSocket 的读线程），
 * 订阅事件与通道事件的回调在调用 [receive] 的线程上执行。
 */
class ClientSecureChannel private constructor(
    val deviceId: String,
    private val identity: NoiseKeyPair,
    val ch: String,
    private val wire: ChannelWire,
    private val now: () -> Long,
) {
    val clientId: String = E2eeFormats.clientIdFor(identity.publicKey)

    private val lock = Any()
    private val handshakeInbox = Channel<ChannelItem>(Channel.UNLIMITED)
    private var transport: TransportSession? = null
    private var closedError: ChannelClosedException? = null
    private var committed: PairResultParts? = null
    private val readyDeferred = CompletableDeferred<ChannelReady>()
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<TunnelResponse>>()
    private val subscriptions = ConcurrentHashMap<String, (JSONObject) -> Unit>()
    private val channelEventListeners = CopyOnWriteArrayList<(JSONObject) -> Unit>()
    private val closeListeners = CopyOnWriteArrayList<(ChannelClosedException) -> Unit>()

    private class PairResultParts(val grantedAt: String, val directoryKey: DirectoryKeyGrant)

    init {
        if (!E2eeFormats.isChannelId(ch)) throw IllegalArgumentException("invalid channel id")
    }

    val ready: ChannelReady? get() = if (readyDeferred.isCompleted && closedError == null) readyDeferred.getCompletedOrNull() else null

    val closed: ChannelClosedException? get() = synchronized(lock) { closedError }

    val isOpen: Boolean get() = ready != null

    /** 送进一帧（隧道 WebSocket 收到的 `ClientTunnelFrame`）。 */
    fun receive(item: ChannelItem) {
        val actions = ArrayList<() -> Unit>()
        synchronized(lock) {
            if (closedError != null) return
            val current = transport
            if (current == null) {
                handshakeInbox.trySend(item)
                return
            }
            processLocked(current, item, actions)
        }
        actions.forEach { runCatching(it) }
    }

    /** Server 结束了这条通道（`ClientTunnelEnd`），或 WebSocket 断开。 */
    fun ended(code: String) {
        fail(ChannelClosedException(code), notifyWire = false)
    }

    fun onChannelEvent(listener: (JSONObject) -> Unit): () -> Unit {
        channelEventListeners += listener
        return { channelEventListeners -= listener }
    }

    fun onClose(listener: (ChannelClosedException) -> Unit) {
        closeListeners += listener
        closed?.let(listener)
    }

    /**
     * 经通道发一个客户端 API 请求。`bodyJson` 原样放进 `TunnelRequest.body`（不重新序列化），
     * 所以对同一个字符串算出的 [E2eeFormats.inputDigest] 就是设备收到的请求体的摘要。
     */
    suspend fun request(method: String, path: String, bodyJson: String? = null): TunnelResponse {
        require(method in METHODS) { "unsupported method $method" }
        val current = requireOpen()
        val id = "r${nextId.getAndIncrement()}"
        val deferred = CompletableDeferred<TunnelResponse>()
        pending[id] = deferred
        try {
            val head = JSONObject().put("kind", "request").put("id", id).put("method", method).put("path", path).toString()
            current.sendMessage(head.dropLast(1) + ",\"body\":" + (bodyJson?.takeIf { it.isNotBlank() } ?: "null") + "}")
            return deferred.await()
        } catch (error: CancellationException) {
            pending.remove(id)
            throw error
        } catch (error: Throwable) {
            pending.remove(id)
            throw closed ?: error
        }
    }

    /** 相当于普通模式下打开会话 WS；返回订阅 id，用于 [unsubscribe]。 */
    fun subscribe(sessionId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): String =
        subscribeStream(JSONObject().put("stream", "session").put("sessionId", sessionId), afterCursor, onEvent)

    /** 相当于普通模式下打开 `terminals-v2/{terminalId}/stream`：每个事件就是那条 WS 的一条消息。 */
    fun subscribeTerminal(terminalId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): String =
        subscribeStream(JSONObject().put("stream", "terminal").put("terminalId", terminalId), afterCursor, onEvent)

    private fun subscribeStream(target: JSONObject, afterCursor: String?, onEvent: (JSONObject) -> Unit): String {
        val current = requireOpen()
        val id = "s${nextId.getAndIncrement()}"
        subscriptions[id] = onEvent
        try {
            current.sendMessage(
                target
                    .put("kind", "subscribe")
                    .put("id", id)
                    .put("afterCursor", afterCursor ?: JSONObject.NULL),
            )
        } catch (error: Throwable) {
            subscriptions.remove(id)
            throw closed ?: error
        }
        return id
    }

    fun unsubscribe(id: String) {
        if (subscriptions.remove(id) == null) return
        val current = synchronized(lock) { transport.takeIf { closedError == null } } ?: return
        runCatching { current.sendMessage(JSONObject().put("kind", "unsubscribe").put("id", id)) }
    }

    fun rekeyNow() = requireOpen().rekeyNow()

    /** 本方向已发出的帧数（测试用）。 */
    internal val sendNonce: ULong get() = synchronized(lock) { transport }?.sendNonce ?: 0u

    fun close() {
        val current = synchronized(lock) { transport.takeIf { closedError == null } }
        if (closed != null) return
        runCatching { current?.sendMessage(JSONObject().put("kind", "close").put("reason", "shutdown").put("message", "")) }
        fail(ChannelClosedException(E2eeErrorCodes.CLOSED), notifyWire = true)
    }

    private fun requireOpen(): TransportSession {
        synchronized(lock) {
            closedError?.let { throw it }
            val current = transport
            if (current == null || !readyDeferred.isCompleted) throw IllegalStateException("channel not ready")
            return current
        }
    }

    // --- handshake -----------------------------------------------------------------------

    private suspend fun nextHandshakeItem(): ChannelItem = try {
        handshakeInbox.receive()
    } catch (error: ChannelClosedException) {
        throw error
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        throw closed ?: ChannelClosedException(E2eeErrorCodes.CLOSED)
    }

    /** 握手结束：从此帧走传输层；握手期间已经到达的传输帧按顺序处理。 */
    private fun startTransport(session: TransportSession) {
        val actions = ArrayList<() -> Unit>()
        synchronized(lock) {
            if (closedError != null) {
                session.destroy()
                return
            }
            transport = session
            while (closedError == null) {
                val item = handshakeInbox.tryReceive().getOrNull() ?: break
                processLocked(session, item, actions)
            }
        }
        actions.forEach { runCatching(it) }
    }

    private suspend fun <T> handshakeStep(failureCode: String, block: suspend () -> T): T = try {
        block()
    } catch (error: ChannelClosedException) {
        fail(error, notifyWire = true)
        // The more specific local verdict wins (e.g. a KK failure the Server reported is a pin mismatch to us).
        throw error
    } catch (error: CancellationException) {
        fail(ChannelClosedException(E2eeErrorCodes.CLOSED), notifyWire = true)
        throw error
    } catch (error: ChannelProtocolException) {
        val closedError = ChannelClosedException(error.code, error.message.orEmpty())
        fail(closedError, notifyWire = true)
        throw closedError
    } catch (error: Exception) {
        val closedError = ChannelClosedException(failureCode, error.message ?: failureCode)
        fail(closedError, notifyWire = true)
        throw closedError
    }

    private suspend fun runPairing(payload: PairingPayload, label: String, platform: String, appVersion: String?): PairResult {
        val hs = NoiseHandshake(
            protocolName = E2eeFormats.NOISE_PAIRING_PROTOCOL,
            initiator = true,
            prologue = E2eeFormats.pairingPrologue(payload.deviceId, payload.pairingId, clientId, ch),
            s = identity,
            psks = listOf(payload.pskBytes),
        )
        handshakeStep(E2eeErrorCodes.HANDSHAKE_FAILED) {
            wire.send(HandshakeEnvelope(HandshakeEnvelope.PAIRING, payload.pairingId, 0, E2eeFormats.b64url(hs.writeMessage())).encode())
            val reply = HandshakeEnvelope.decode(nextHandshakeItem(), 1)
            val hello = try {
                JSONObject(hs.readMessage(E2eeFormats.fromB64url(reply.message)).toString(Charsets.UTF_8))
            } catch (error: NoiseException) {
                throw ChannelClosedException(E2eeErrorCodes.HANDSHAKE_FAILED, error.message.orEmpty())
            }
            // 握手里的设备公钥必须是二维码里的那把，设备也必须是扫到的那台。
            val remote = hs.remoteStatic
            if (remote == null || !remote.contentEquals(payload.deviceIdentityPubBytes) || hello.optString("deviceId") != payload.deviceId) {
                throw ChannelClosedException(E2eeErrorCodes.DEVICE_PIN_MISMATCH, "the device key does not match the QR code")
            }
            val clientHello = JSONObject().put("label", label).put("platform", platform)
            if (appVersion != null) clientHello.put("appVersion", appVersion)
            val finish = hs.writeMessage(clientHello.toString().toByteArray(Charsets.UTF_8))
            wire.send(HandshakeEnvelope(HandshakeEnvelope.PAIRING, payload.pairingId, 2, E2eeFormats.b64url(finish)).encode())
            startTransport(TransportSession(hs.takeTransport(), wire, now))
            awaitReady()
        }
        val parts = synchronized(lock) { committed }
            ?: return handshakeStep(E2eeErrorCodes.PROTOCOL_ERROR) {
                throw ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, "ready before pair.committed")
            }
        return PairResult(this, parts.grantedAt, parts.directoryKey)
    }

    private suspend fun runConnect(devicePub: ByteArray) {
        val hs = NoiseHandshake(
            protocolName = E2eeFormats.NOISE_RECONNECT_PROTOCOL,
            initiator = true,
            prologue = E2eeFormats.connectPrologue(deviceId, clientId, ch),
            s = identity,
            rs = devicePub,
        )
        handshakeStep(E2eeErrorCodes.DEVICE_PIN_MISMATCH) {
            wire.send(HandshakeEnvelope(HandshakeEnvelope.RECONNECT, null, 0, E2eeFormats.b64url(hs.writeMessage())).encode())
            val item = try {
                nextHandshakeItem()
            } catch (error: ChannelClosedException) {
                // 设备读不了我们用钉住公钥算的 KK 消息：设备身份变了（或路由被改写）。
                // 客户端不因此放松：必须重新配对。
                if (error.code == E2eeErrorCodes.HANDSHAKE_FAILED) {
                    throw ChannelClosedException(E2eeErrorCodes.DEVICE_PIN_MISMATCH, "the device could not answer with the pinned key")
                }
                throw error
            }
            val reply = HandshakeEnvelope.decode(item, 1)
            try {
                hs.readMessage(E2eeFormats.fromB64url(reply.message))
            } catch (_: Exception) {
                // 只有持有钉住私钥的设备能回答 KK：别的回答都说明设备身份变了。
                throw ChannelClosedException(E2eeErrorCodes.DEVICE_PIN_MISMATCH, "the device did not prove the pinned key")
            }
            startTransport(TransportSession(hs.takeTransport(), wire, now))
            awaitReady()
        }
    }

    private suspend fun awaitReady(): ChannelReady = readyDeferred.await()

    // --- transport messages ------------------------------------------------------------------

    private fun processLocked(session: TransportSession, item: ChannelItem, actions: MutableList<() -> Unit>) {
        try {
            for (message in session.receive(item)) dispatchLocked(message, actions)
        } catch (error: ChannelProtocolException) {
            failLocked(ChannelClosedException(error.code, error.message.orEmpty()), notifyWire = true, actions)
        } catch (error: ChannelClosedException) {
            failLocked(error, notifyWire = true, actions)
        } catch (error: Exception) {
            failLocked(ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, error.message.orEmpty()), notifyWire = true, actions)
        }
    }

    private fun dispatchLocked(message: JSONObject, actions: MutableList<() -> Unit>) {
        when (val kind = message.optString("kind")) {
            "pair.committed" -> {
                if (message.optString("deviceId") != deviceId || message.optString("clientId") != clientId) {
                    throw ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, "pair.committed names another client or device")
                }
                val grant = DirectoryKeyGrant.parse(message.optJSONObject("directoryKey"))
                if (grant.deviceId != deviceId) throw ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, "directory key of another device")
                committed = PairResultParts(message.optString("grantedAt"), grant)
            }
            "ready" -> {
                if (message.optString("clientId") != clientId || message.optString("deviceId") != deviceId) {
                    throw ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, "ready names another client or device")
                }
                val ready = ChannelReady(
                    deviceId = deviceId,
                    clientId = clientId,
                    directoryKeyId = message.optString("directoryKeyId"),
                    directoryKeyEpoch = message.optLong("directoryKeyEpoch", 0),
                )
                readyDeferred.complete(ready)
            }
            "response" -> {
                val id = message.optString("id")
                val body = if (message.isNull("body")) null else message.opt("body")
                val response = TunnelResponse(message.optInt("status", 0), body)
                pending.remove(id)?.let { deferred -> actions += { deferred.complete(response) } }
            }
            "event" -> {
                val event = message.optJSONObject("event") ?: throw ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, "event without body")
                val sub = if (message.isNull("sub")) null else message.optString("sub").takeIf { it.isNotEmpty() }
                if (sub != null) {
                    subscriptions[sub]?.let { listener -> actions += { listener(event) } }
                } else {
                    channelEventListeners.forEach { listener -> actions += { listener(event) } }
                }
            }
            "close" -> {
                val reason = message.optString("reason")
                val detail = message.optString("message")
                // Code from the reason, never from the free-form message: the reason is the contract.
                throw ChannelClosedException(closeReasonCode(reason), detail.ifBlank { reason }, fromDevice = true)
            }
            else -> throw ChannelClosedException(E2eeErrorCodes.PROTOCOL_ERROR, "unexpected message $kind")
        }
    }

    private fun fail(error: ChannelClosedException, notifyWire: Boolean) {
        val actions = ArrayList<() -> Unit>()
        synchronized(lock) { failLocked(error, notifyWire, actions) }
        actions.forEach { runCatching(it) }
    }

    private fun failLocked(error: ChannelClosedException, notifyWire: Boolean, actions: MutableList<() -> Unit>) {
        if (closedError != null) return
        closedError = error
        transport?.destroy()
        handshakeInbox.close(error)
        readyDeferred.completeExceptionally(error)
        val waiting = pending.values.toList()
        pending.clear()
        subscriptions.clear()
        actions += {
            waiting.forEach { it.completeExceptionally(error) }
            if (notifyWire) wire.end(if (error.code == E2eeErrorCodes.DEVICE_PIN_MISMATCH) E2eeErrorCodes.CLOSED else endCode(error.code))
            closeListeners.forEach { listener -> runCatching { listener(error) } }
        }
    }

    companion object {
        val METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE")

        /** 首次配对（扫码）。设备写入授权、发出 `pair.committed` 和 `ready` 后返回。 */
        suspend fun pair(
            payload: PairingPayload,
            identity: NoiseKeyPair,
            ch: String,
            wire: ChannelWire,
            label: String,
            platform: String = "android",
            appVersion: String? = null,
            now: () -> Long = System::currentTimeMillis,
            bind: (ClientSecureChannel) -> Unit = {},
        ): PairResult {
            val channel = ClientSecureChannel(payload.deviceId, identity, ch, wire, now)
            bind(channel)
            return channel.runPairing(payload, label, platform, appVersion)
        }

        /** 重连已配对的设备；`devicePub` 是钉住的设备公钥。 */
        suspend fun connect(
            deviceId: String,
            devicePub: ByteArray,
            identity: NoiseKeyPair,
            ch: String,
            wire: ChannelWire,
            now: () -> Long = System::currentTimeMillis,
            bind: (ClientSecureChannel) -> Unit = {},
        ): ClientSecureChannel {
            val channel = ClientSecureChannel(deviceId, identity, ch, wire, now)
            bind(channel)
            channel.runConnect(devicePub)
            return channel
        }

        /** 每次握手一个新的 `ch`。 */
        fun newChannelId(): String = "c_" + E2eeFormats.b64url(ByteArray(12).also(java.security.SecureRandom()::nextBytes))

        private fun closeReasonCode(reason: String): String = when (reason) {
            "revoked", "not_paired" -> E2eeErrorCodes.NOT_PAIRED
            "too_large" -> E2eeErrorCodes.TOO_LARGE
            "protocol_error" -> E2eeErrorCodes.PROTOCOL_ERROR
            "policy" -> E2eeErrorCodes.E2EE_REQUIRED
            "shutdown" -> E2eeErrorCodes.CLOSED
            else -> E2eeErrorCodes.PROTOCOL_ERROR
        }

        /** 只把契约里的 TunnelEndCode 发给 Server。 */
        private fun endCode(code: String): String = when (code) {
            E2eeErrorCodes.CLOSED,
            E2eeErrorCodes.NOT_PAIRED,
            E2eeErrorCodes.PAIRING_EXPIRED,
            E2eeErrorCodes.HANDSHAKE_FAILED,
            E2eeErrorCodes.PROTOCOL_ERROR,
            E2eeErrorCodes.TOO_LARGE,
            -> code
            else -> E2eeErrorCodes.CLOSED
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
private fun <T> CompletableDeferred<T>.getCompletedOrNull(): T? = runCatching { getCompleted() }.getOrNull()
