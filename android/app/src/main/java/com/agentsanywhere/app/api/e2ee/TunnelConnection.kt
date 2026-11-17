package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.normalizeServerOrigin
import com.agentsanywhere.app.api.urlEncode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** `ClientTunnelFrame.route`：一条通道在隧道上的地址。 */
data class TunnelRoute(val deviceId: String, val clientId: String, val ch: String) {
    fun toJson(): JSONObject = JSONObject().put("deviceId", deviceId).put("clientId", clientId).put("ch", ch)

    internal val key: String get() = "$deviceId\u0000$clientId\u0000$ch"

    companion object {
        fun parse(json: JSONObject?): TunnelRoute? {
            json ?: return null
            val route = TunnelRoute(json.optString("deviceId"), json.optString("clientId"), json.optString("ch"))
            return route.takeIf { it.deviceId.isNotEmpty() && it.clientId.isNotEmpty() && it.ch.isNotEmpty() }
        }
    }
}

/** 一条路由收到的东西：设备的帧，或者通道结束（`ClientTunnelEnd`、WebSocket 断开）。 */
interface TunnelListener {
    fun onFrame(item: ChannelItem)
    fun onEnd(code: String)
}

/**
 * 隧道连接（打开 / 发帧 / 收帧 / 结束）。Server 只读 `route` 与 `n`，`ct` 对它不透明。
 * 默认实现是 [WebSocketTunnelConnection]；测试里直接把两端接起来。
 */
interface TunnelConnection {
    /** 打开一条路由；返回往这条路由发帧、结束它的 [ChannelWire]。 */
    suspend fun open(route: TunnelRoute, listener: TunnelListener): ChannelWire
}

/** 把一条路由收到的东西按顺序转给 [ClientSecureChannel]；通道绑定之前到达的先缓存。 */
class ChannelBinding : TunnelListener {
    private val lock = Any()
    private var channel: ClientSecureChannel? = null
    private val early = ArrayList<ChannelItem>()
    private var endedEarly: String? = null

    fun bind(target: ClientSecureChannel) = synchronized(lock) {
        channel = target
        early.forEach(target::receive)
        early.clear()
        endedEarly?.let(target::ended)
    }

    override fun onFrame(item: ChannelItem) = synchronized(lock) {
        channel?.receive(item) ?: early.add(item)
        Unit
    }

    override fun onEnd(code: String) = synchronized(lock) {
        channel?.ended(code) ?: run { endedEarly = code }
        Unit
    }
}

/**
 * 默认的隧道：`POST /api/v2/ws-ticket {clientId, scope: {tunnel: true}}` 拿票，再连 `WS /api/v3/tunnel?ticket=…`；
 * 收发 `ClientTunnelFrame {t: "tun", route, n, ct}` 与 `ClientTunnelEnd {t: "end", route, code}`。
 * 一条 WebSocket 复用给所有路由；断开时所有路由收到 [E2eeErrorCodes.TUNNEL_DISCONNECTED]，下次 [open] 重新连接。
 *
 * 注意：Server 侧的隧道 WebSocket 与 `tunnel` 票据 scope 还没实现，这里只按契约写了客户端，未联调。
 */
class WebSocketTunnelConnection(
    private val serverUrl: () -> String,
    private val accessToken: () -> String,
    private val client: () -> ApiClient = { ApiClient() },
    private val socketClient: OkHttpClient = DEFAULT_SOCKET_CLIENT,
) : TunnelConnection {
    private val connectMutex = Mutex()
    private val routes = ConcurrentHashMap<String, Pair<TunnelRoute, TunnelListener>>()

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var socketClientId: String? = null

    override suspend fun open(route: TunnelRoute, listener: TunnelListener): ChannelWire {
        val ws = ensureSocket(route.clientId)
        routes[route.key] = route to listener
        return object : ChannelWire {
            override fun send(item: ChannelItem) {
                val frame = JSONObject().put("t", "tun").put("route", route.toJson()).put("n", item.n).put("ct", item.ct)
                if (!ws.send(frame.toString())) throw ChannelClosedException(E2eeErrorCodes.TUNNEL_DISCONNECTED, "tunnel is closed")
            }

            override fun end(code: String) {
                if (routes.remove(route.key) == null) return
                ws.send(JSONObject().put("t", "end").put("route", route.toJson()).put("code", code).toString())
            }
        }
    }

    /** 关闭整条隧道（例如退出登录）。 */
    fun shutdown() {
        socket?.close(1000, "client shutdown")
        socket = null
        endAll(E2eeErrorCodes.TUNNEL_DISCONNECTED)
    }

    private suspend fun ensureSocket(clientId: String): WebSocket = connectMutex.withLock {
        socket?.takeIf { socketClientId == clientId }?.let { return@withLock it }
        socket?.close(1000, "identity changed")
        val ticket = withContext(Dispatchers.IO) {
            client().postJson(
                serverUrl = serverUrl(),
                path = "/ws-ticket",
                body = JSONObject().put("clientId", clientId).put("scope", JSONObject().put("tunnel", true)),
                authorizationToken = accessToken(),
            ).optString("ticket").takeIf { it.isNotBlank() } ?: throw ApiException("The server returned an invalid tunnel ticket.")
        }
        val url = tunnelWebSocketUrl(serverUrl(), ticket)
        lateinit var created: WebSocket
        created = socketClient.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = handleMessage(text)

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = disconnected(webSocket)
        })
        socket = created
        socketClientId = clientId
        created
    }

    private fun disconnected(webSocket: WebSocket) {
        if (socket !== webSocket) return
        socket = null
        endAll(E2eeErrorCodes.TUNNEL_DISCONNECTED)
    }

    private fun endAll(code: String) {
        val listeners = routes.values.map { it.second }
        routes.clear()
        listeners.forEach { runCatching { it.onEnd(code) } }
    }

    internal fun handleMessage(text: String) {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        val route = TunnelRoute.parse(message.optJSONObject("route")) ?: return
        when (message.optString("t")) {
            "tun" -> {
                val n = (message.opt("n") as? Number)?.toLong() ?: return
                val ct = message.optString("ct").takeIf { it.isNotEmpty() } ?: return
                routes[route.key]?.second?.onFrame(ChannelItem(n, ct))
            }
            "end" -> routes.remove(route.key)?.second?.onEnd(message.optString("code").ifBlank { E2eeErrorCodes.CLOSED })
        }
    }

    companion object {
        private val DEFAULT_SOCKET_CLIENT: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()

        fun tunnelWebSocketUrl(serverUrl: String, ticket: String): String {
            val origin = requireNotNull(normalizeServerOrigin(serverUrl)) { "Server URL must be an HTTP(S) origin." }
            val wsOrigin = when {
                origin.startsWith("https://") -> "wss://" + origin.removePrefix("https://")
                else -> "ws://" + origin.removePrefix("http://")
            }
            return "$wsOrigin/api/v3/tunnel?ticket=${ticket.urlEncode()}"
        }
    }
}
