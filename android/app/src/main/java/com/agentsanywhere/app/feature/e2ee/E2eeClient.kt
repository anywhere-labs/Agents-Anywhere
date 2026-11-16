package com.agentsanywhere.app.feature.e2ee

import android.content.Context
import com.agentsanywhere.app.api.ApiClient
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
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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
    /** 每个经通道的请求（含按需重连）的统一超时；超时抛 [E2eeTimeoutException]。 */
    private val requestTimeoutMillis: Long = DEFAULT_REQUEST_TIMEOUT_MS,
) {
    private val channels = ConcurrentHashMap<String, ClientSecureChannel>()
    private val connectLocks = ConcurrentHashMap<String, Mutex>()
    private val dismissedPrompts = ConcurrentHashMap.newKeySet<String>()
    private val pairingPromptState = MutableStateFlow<String?>(null)

    /** 需要配对的设备（内容请求因为没有配对被拒绝时）；界面据此弹出配对面板。 */
    val pairingPrompt: StateFlow<String?> = pairingPromptState.asStateFlow()

    /** 请界面提示配对；用户关掉过的设备在本进程内不再自动弹出。 */
    fun promptPairing(deviceId: String) {
        if (deviceId !in dismissedPrompts) pairingPromptState.value = deviceId
    }

    fun dismissPairingPrompt(deviceId: String) {
        dismissedPrompts += deviceId
        pairingPromptState.compareAndSet(deviceId, null)
    }

    /**
     * 本机与这个实例完全没有加密要求（没配对过、没记下过要求、Server 也没要求过）：
     * 这时所有内容照常走明文，不需要先查会话属于哪台设备。
     */
    fun encryptionInPlay(): Boolean = requiresEncryptionForUnknownDevice() || trust.anyDeviceRecord()

    /** 不知道会话属于哪台设备时：本实例要求过加密，就不能退回明文。 */
    fun requiresEncryptionForUnknownDevice(): Boolean = serverConfig.required || trust.instanceRequired()

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
        timed { channel(deviceId).requestJson(method, path, body) }

    /** 同上，请求体原样（不重新序列化），返回设备的原始响应。 */
    suspend fun requestRaw(
        deviceId: String,
        method: String,
        path: String,
        bodyJson: String?,
        timeoutMillis: Long = requestTimeoutMillis,
    ): TunnelResponse = timed(timeoutMillis) { channel(deviceId).request(method, apiPath(path), bodyJson) }

    /**
     * 经通道订阅一个会话的事件流（相当于普通模式的会话 WS）；返回取消订阅的函数。
     * 通道关闭时调用 [onClosed]（之后不会再有事件，调用方重新订阅即可）。
     */
    suspend fun subscribe(
        deviceId: String,
        sessionId: String,
        afterCursor: String?,
        onEvent: (JSONObject) -> Unit,
        onClosed: (ChannelClosedException) -> Unit = {},
    ): () -> Unit {
        val channel = timed { channel(deviceId) }
        channel.onClose(onClosed)
        val id = channel.subscribe(sessionId, afterCursor, onEvent)
        return { channel.unsubscribe(id) }
    }

    /** 经通道订阅设备终端的输出流（`stream: "terminal"`）；返回取消订阅的函数。 */
    suspend fun subscribeTerminal(
        deviceId: String,
        terminalId: String,
        afterCursor: String?,
        onEvent: (JSONObject) -> Unit,
        onClosed: (ChannelClosedException) -> Unit = {},
    ): () -> Unit {
        val channel = timed { channel(deviceId) }
        channel.onClose(onClosed)
        val id = channel.subscribeTerminal(terminalId, afterCursor, onEvent)
        return { channel.unsubscribe(id) }
    }

    /**
     * 加密模式下发命令：先 `POST /api/v3/e2ee/commands`（输入摘要用当前列表密钥），
     * Server 说重复时返回 null、不再发；否则经通道发出 `bodyJson` 原文。
     */
    suspend fun sendCommand(
        deviceId: String,
        commandId: String,
        method: String,
        path: String,
        bodyJson: String,
        timeoutMillis: Long = requestTimeoutMillis,
    ): TunnelResponse? = timed(timeoutMillis) {
        val channel = channel(deviceId)
        val key = trust.directoryKey(deviceId) ?: throw ChannelClosedException(E2eeErrorCodes.NOT_PAIRED)
        val digest = E2eeFormats.inputDigest(key.keyBytes, bodyJson.toByteArray(Charsets.UTF_8))
        if (commands.register(commandId, deviceId, digest)) return@timed null
        channel.request(method, apiPath(path), bodyJson)
    }

    private suspend fun <T> timed(timeoutMillis: Long = requestTimeoutMillis, block: suspend () -> T): T = try {
        withTimeout(timeoutMillis) { block() }
    } catch (_: TimeoutCancellationException) {
        throw E2eeTimeoutException()
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
        const val DEFAULT_REQUEST_TIMEOUT_MS = 30_000L

        private val NOT_RECOVERABLE = setOf(
            E2eeErrorCodes.DEVICE_PIN_MISMATCH,
            E2eeErrorCodes.PAIRING_EXPIRED,
            E2eeErrorCodes.NOT_PAIRED,
            E2eeErrorCodes.HANDSHAKE_FAILED,
        )

        @Volatile
        private var instance: E2eeClient? = null

        /** The app's [ApiClient] (with token refresh); tickets, command registration and config use it. */
        @Volatile
        private var appApiClient: ApiClient? = null

        /** App 启动时调用：之后隧道票据、命令登记都用 App 的 ApiClient（会自动刷新 token）。 */
        fun install(context: Context, apiClient: ApiClient): E2eeClient {
            appApiClient = apiClient
            return get(context)
        }

        /** 进程内共用一个：同一身份、同一条隧道 WebSocket。 */
        fun get(context: Context): E2eeClient = instance ?: synchronized(this) {
            instance ?: create(context.applicationContext).also { instance = it }
        }

        private fun create(context: Context): E2eeClient {
            val session = AuthSessionStore(context)
            val apiClient = { appApiClient ?: DEFAULT_API_CLIENT }
            return E2eeClient(
                trust = ClientTrustStore.create(context),
                tunnel = WebSocketTunnelConnection(
                    serverUrl = session::readServerUrl,
                    accessToken = session::readAccessToken,
                    client = apiClient,
                ),
                commands = { commandId, deviceId, digest ->
                    withContext(Dispatchers.IO) {
                        E2eeApi(apiClient()).registerCommand(session.readServerUrl(), session.readAccessToken(), commandId, deviceId, digest).duplicate
                    }
                },
                loadServerConfig = { withContext(Dispatchers.IO) { AuthApi(apiClient()).authConfig(session.readServerUrl()).e2ee } },
            )
        }

        private val DEFAULT_API_CLIENT by lazy { ApiClient() }
    }
}

/** 设备没有在统一超时内回答（错误码 `e2ee_timeout`）。 */
class E2eeTimeoutException : Exception("The device did not answer in time.")
