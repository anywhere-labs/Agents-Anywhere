package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.E2eeServerConfig

/** 一台设备的内容请求走哪条路。 */
sealed interface DeviceTransport {
    /** 普通模式：现有的 HTTP / WS。 */
    data object Plain : DeviceTransport

    /** 已配对：内容请求经安全通道（`request`），事件流经 `subscribe`。 */
    data class Secure(val device: PairedDevice) : DeviceTransport

    /** 要求加密但本机还没有配对：不能退回明文，先扫码配对。 */
    data class PairingRequired(val deviceId: String) : DeviceTransport
}

/**
 * 按设备选择传输。
 *
 * - 已配对的设备一律走通道，不管 Server 现在怎么说；
 * - 没配对时，Server 要求加密，或者本机记下过「该设备要求加密」（降级保护），都不能走明文；
 * - 其余情况走普通模式。
 */
object E2eeTransportPolicy {
    fun select(
        deviceId: String,
        server: E2eeServerConfig,
        paired: PairedDevice?,
        locallyRequired: Boolean,
    ): DeviceTransport = when {
        paired != null -> DeviceTransport.Secure(paired)
        server.required || locallyRequired -> DeviceTransport.PairingRequired(deviceId)
        else -> DeviceTransport.Plain
    }
}
