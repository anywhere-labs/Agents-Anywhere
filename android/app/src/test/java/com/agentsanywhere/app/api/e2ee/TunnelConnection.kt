package com.agentsanywhere.app.api.e2ee

import org.json.JSONObject

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
 * 仅供进程内协议测试作为通道对端。
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
