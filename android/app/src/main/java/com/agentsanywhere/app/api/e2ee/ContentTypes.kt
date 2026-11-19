package com.agentsanywhere.app.api.e2ee

import org.json.JSONArray
import org.json.JSONObject

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


class ChannelProtocolException(message: String, val code: String = E2eeErrorCodes.PROTOCOL_ERROR) : Exception(message)

object E2eeErrorCodes {
    const val NOT_PAIRED = "e2ee_not_paired"
    const val PAIRING_EXPIRED = "pairing_expired"
    const val HANDSHAKE_FAILED = "e2ee_handshake_failed"
    const val PROTOCOL_ERROR = "e2ee_protocol_error"
    const val DEVICE_PIN_MISMATCH = "device_pin_mismatch"
    const val TOO_LARGE = "too_large"
    const val CONNECTOR_OFFLINE = "connector_offline"
    const val E2EE_REQUIRED = "e2ee_required"
    const val CLOSED = "closed"

    /** 客户端本地：隧道 WebSocket 断开。 */
    const val TUNNEL_DISCONNECTED = "tunnel_disconnected"
}
