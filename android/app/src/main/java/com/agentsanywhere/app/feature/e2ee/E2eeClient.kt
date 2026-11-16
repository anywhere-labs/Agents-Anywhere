package com.agentsanywhere.app.feature.e2ee

import android.content.Context
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.E2eeServerConfig
import com.agentsanywhere.app.api.apiPath
import com.agentsanywhere.app.api.e2ee.ChannelBinding
import com.agentsanywhere.app.api.e2ee.ChannelClosedException
import com.agentsanywhere.app.api.e2ee.ClientSecureChannel
import com.agentsanywhere.app.api.e2ee.DirectoryKeyGrant
import com.agentsanywhere.app.api.e2ee.E2eeApi
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.e2ee.PairingPayload
import com.agentsanywhere.app.api.e2ee.TunnelConnection
import com.agentsanywhere.app.api.e2ee.TunnelResponse
import com.agentsanywhere.app.api.e2ee.TunnelRoute
import com.agentsanywhere.app.api.e2ee.WebSocketTunnelConnection
import com.agentsanywhere.app.api.e2ee.requestJson
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/** `POST /api/v3/e2ee/commands`；返回 true 表示 Server 说这是重复命令。 */
fun interface CommandRegistrar {
    suspend fun register(commandId: String, deviceId: String, inputDigest: String): Boolean
}

/**
 * 加密模式的入口：配对、按设备选择传输、维护每台设备一条安全通道、经通道发请求和命令。
 *
 * 这是「按设备选择传输的适配点」：调用方先 [transportFor]，`Secure` 时用 [request] / [subscribe] /
 * [sendCommand]，`PairingRequired` 时提示配对，`Plain` 时走现有的 HTTP / WS。
 */
class E2eeClient(
    private val trust: ClientTrustStore,
    private val tunnel: TunnelConnection,
    private val commands: CommandRegistrar,
    private val loadServerConfig: suspend () -> E2eeServerConfig,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val channels = ConcurrentHashMap<String, ClientSecureChannel>()
    private val connectLocks = ConcurrentHashMap<String, Mutex>()

    @Volatile
    var serverConfig: E2eeServerConfig = E2eeServerConfig()
        private set

    val clientId: String get() = trust.clientId()
    val clientFingerprint: String get() = trust.clientFingerprint()

    /** 读 `GET /auth/config` 的 `e2ee`；读不到时保留上次的值（不因为网络错误放松）。 */
    suspend fun refreshServerConfig(): E2eeServerConfig {
        runCatching { loadServerConfig() }.onSuccess {
            serverConfig = it
            if (it.required) trust.markInstanceRequired()
        }
        return serverConfig
    }

    fun pairedDevice(deviceId: String): PairedDevice? = trust.device(deviceId)

    fun transportFor(deviceId: String): DeviceTransport = E2eeTransportPolicy.select(
        deviceId = deviceId,
        server = serverConfig,
        paired = trust.device(deviceId),
        locallyRequired = trust.instanceRequired() || trust.requiresEncryption(deviceId),
    )

    /** 扫码配对（XXpsk0）；成功后保存授权、列表密钥，并记下「该设备要求加密」。 */
    suspend fun pair(payload: PairingPayload, label: String, appVersion: String? = null): PairedDevice {
        if (isExpired(payload)) throw ChannelClosedException(E2eeErrorCodes.PAIRING_EXPIRED)
        val identity = trust.identity()
        val ch = ClientSecureChannel.newChannelId()
        val binding = ChannelBinding()
        val wire = tunnel.open(TunnelRoute(payload.deviceId, E2eeFormats.clientIdFor(identity.publicKey), ch), binding)
        val result = try {
            ClientSecureChannel.pair(payload, identity, ch, wire, label, "android", appVersion, now, binding::bind)
        } catch (error: ChannelClosedException) {
            if (error.code in NOT_RECOVERABLE) throw error
            // pair.committed 丢了：KK 能成功就说明授权已经写入（契约「通道的建立」）。
            return recoverPairing(payload) ?: throw error
        }
        val record = trust.savePairing(payload.deviceId, payload.deviceIdentityPubBytes, result.grantedAt, result.directoryKey)
        adopt(result.channel)
        return record
    }

    /** 已配对设备的通道；没有或已断开时用 KK 重新连接（每次一个新的 `ch`）。 */
    suspend fun channel(deviceId: String): ClientSecureChannel {
        channels[deviceId]?.takeIf { it.isOpen }?.let { return it }
        return connectLocks.getOrPut(deviceId) { Mutex() }.withLock {
            channels[deviceId]?.takeIf { it.isOpen }?.let { return@withLock it }
            val device = trust.device(deviceId) ?: throw ChannelClosedException(E2eeErrorCodes.NOT_PAIRED)
            // A Server-relayed `e2ee_not_paired` before the handshake can be forged: report it, keep the pin.
            val channel = connect(deviceId, device.devicePubBytes)
            syncDirectoryKey(channel)
            adopt(channel)
            channel
        }
    }

    /** 经通道发一个内容请求（快照、时间线等）。 */
    suspend fun request(deviceId: String, method: String, path: String, body: JSONObject? = null): JSONObject =
        channel(deviceId).requestJson(method, path, body)

    /** 经通道订阅一个会话的事件流（相当于普通模式的会话 WS）；返回取消订阅的函数。 */
    suspend fun subscribe(deviceId: String, sessionId: String, afterCursor: String?, onEvent: (JSONObject) -> Unit): () -> Unit {
        val channel = channel(deviceId)
        val id = channel.subscribe(sessionId, afterCursor, onEvent)
        return { channel.unsubscribe(id) }
    }

    /**
     * 加密模式下发命令：先 `POST /api/v3/e2ee/commands`（输入摘要用当前列表密钥），
     * Server 说重复时返回 null、不再发；否则经通道发出 `bodyJson` 原文。
     */
    suspend fun sendCommand(deviceId: String, commandId: String, method: String, path: String, bodyJson: String): TunnelResponse? {
        val channel = channel(deviceId)
        val key = trust.directoryKey(deviceId) ?: throw ChannelClosedException(E2eeErrorCodes.NOT_PAIRED)
        val digest = E2eeFormats.inputDigest(key.keyBytes, bodyJson.toByteArray(Charsets.UTF_8))
        if (commands.register(commandId, deviceId, digest)) return null
        return channel.request(method, apiPath(path), bodyJson)
    }

    fun closeAll() {
        channels.values.toList().forEach { it.close() }
        channels.clear()
    }

    private suspend fun connect(deviceId: String, devicePub: ByteArray): ClientSecureChannel {
        val identity = trust.identity()
        val ch = ClientSecureChannel.newChannelId()
        val binding = ChannelBinding()
        val wire = tunnel.open(TunnelRoute(deviceId, E2eeFormats.clientIdFor(identity.publicKey), ch), binding)
        return ClientSecureChannel.connect(deviceId, devicePub, identity, ch, wire, now, binding::bind)
    }

    private suspend fun recoverPairing(payload: PairingPayload): PairedDevice? {
        val channel = runCatching { connect(payload.deviceId, payload.deviceIdentityPubBytes) }.getOrNull() ?: return null
        return runCatching {
            val grant = DirectoryKeyGrant.parse(channel.requestJson("GET", "/e2ee/v1/directory-key"))
            val grants = channel.requestJson("GET", "/e2ee/v1/trust").optJSONArray("grants")
            val grantedAt = (0 until (grants?.length() ?: 0))
                .mapNotNull { grants?.optJSONObject(it) }
                .firstOrNull { it.optString("clientId") == channel.clientId }
                ?.optString("grantedAt")
                .orEmpty()
            trust.savePairing(payload.deviceId, payload.deviceIdentityPubBytes, grantedAt, grant).also { adopt(channel) }
        }.onFailure { channel.close() }.getOrNull()
    }

    /** `ready` 里的列表密钥与本地不同时（设备轮换过），经通道取当前的。 */
    private suspend fun syncDirectoryKey(channel: ClientSecureChannel) {
        val ready = channel.ready ?: return
        val stored = trust.device(channel.deviceId) ?: return
        if (ready.directoryKeyId == stored.directoryKeyId && ready.directoryKeyEpoch == stored.directoryKeyEpoch) return
        runCatching { trust.updateDirectoryKey(DirectoryKeyGrant.parse(channel.requestJson("GET", "/e2ee/v1/directory-key"))) }
    }

    private fun adopt(channel: ClientSecureChannel) {
        channels.put(channel.deviceId, channel)?.takeIf { it !== channel }?.close()
        channel.onChannelEvent { event ->
            if (event.optString("type") == "e2ee.directory_key") {
                runCatching { DirectoryKeyGrant.parse(event.optJSONObject("data") ?: event) }
                    .getOrNull()
                    ?.takeIf { it.deviceId == channel.deviceId }
                    ?.let(trust::updateDirectoryKey)
            }
        }
        channel.onClose { error ->
            channels.remove(channel.deviceId, channel)
            // Only a revocation the device sent inside the authenticated channel may drop the pin.
            if (error.fromDevice && error.code == E2eeErrorCodes.NOT_PAIRED) trust.forgetPairing(channel.deviceId)
        }
    }

    private fun isExpired(payload: PairingPayload): Boolean =
        runCatching { Instant.parse(payload.expiresAt).toEpochMilli() <= now() }.getOrDefault(false)

    companion object {
        private val NOT_RECOVERABLE = setOf(
            E2eeErrorCodes.DEVICE_PIN_MISMATCH,
            E2eeErrorCodes.PAIRING_EXPIRED,
            E2eeErrorCodes.NOT_PAIRED,
            E2eeErrorCodes.HANDSHAKE_FAILED,
        )

        @Volatile
        private var instance: E2eeClient? = null

        /** 进程内共用一个：同一身份、同一条隧道 WebSocket。 */
        fun get(context: Context): E2eeClient = instance ?: synchronized(this) {
            instance ?: create(context.applicationContext).also { instance = it }
        }

        private fun create(context: Context): E2eeClient {
            val session = AuthSessionStore(context)
            val api = E2eeApi()
            return E2eeClient(
                trust = ClientTrustStore.create(context),
                tunnel = WebSocketTunnelConnection(serverUrl = session::readServerUrl, accessToken = session::readAccessToken),
                commands = { commandId, deviceId, digest ->
                    withContext(Dispatchers.IO) {
                        api.registerCommand(session.readServerUrl(), session.readAccessToken(), commandId, deviceId, digest).duplicate
                    }
                },
                loadServerConfig = { withContext(Dispatchers.IO) { AuthApi().authConfig(session.readServerUrl()).e2ee } },
            )
        }
    }
}
