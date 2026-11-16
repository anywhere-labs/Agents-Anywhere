package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.noise.CipherState
import com.agentsanywhere.app.api.e2ee.noise.NoiseException
import com.agentsanywhere.app.api.e2ee.noise.TransportPair
import org.json.JSONException
import org.json.JSONObject

/**
 * 握手完成后的传输层（移植自 connector-ts/src/channel/transport.ts）：分片、重组、
 * 按 2^20 帧或 1 小时 rekey（flag 0x02）、核对接收 nonce 连续。
 */

/** 一个 `{n, ct}`：发往 Server 的 `ClientTunnelFrame` 的内容。 */
data class ChannelItem(val n: Long, val ct: String)

/** 通道写入的管道：客户端这边是隧道 WebSocket 上的一条路由。 */
interface ChannelWire {
    fun send(item: ChannelItem)

    /** 结束通道；`code` 作为 `ClientTunnelEnd.code` 发出。 */
    fun end(code: String = "closed")
}

/** 对端违反协议（nonce 不对、帧不对、MAC 失败）：通道必须关闭。 */
class ChannelProtocolException(message: String, val code: String = E2eeErrorCodes.PROTOCOL_ERROR) : Exception(message)

class TransportSession(
    pair: TransportPair,
    private val wire: ChannelWire,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val send: CipherState = pair.send
    private val receive: CipherState = pair.receive
    private val reassembler = Reassembler()
    private val sendLock = Any()
    private var framesSinceRekey = 0L
    private var lastRekeyMs = now()

    /** 本方向已发出的帧数（含 rekey 帧），测试用。 */
    val sendNonce: ULong get() = synchronized(sendLock) { send.nonce }

    /** 加密并发送一条通道消息（UTF-8 JSON 文本），需要时先 rekey。 */
    fun sendMessage(json: String) {
        val frames = E2eeFormats.fragment(json.toByteArray(Charsets.UTF_8))
        synchronized(sendLock) {
            // Only before a message's first fragment: the receiver rejects a rekey frame inside a message.
            // The frame counter may overshoot 2^20 by one message's worth of fragments, which is fine.
            if (framesSinceRekey >= E2eeFormats.REKEY_INTERVAL_FRAMES || now() - lastRekeyMs >= E2eeFormats.REKEY_INTERVAL_MS) {
                rekeyLocked()
            }
            for (frame in frames) {
                writeFrame(frame)
                framesSinceRekey += 1
            }
        }
    }

    fun sendMessage(message: JSONObject) = sendMessage(message.toString())

    /** 立即 rekey 发送方向（测试，或怀疑密钥暴露时）。 */
    fun rekeyNow() = synchronized(sendLock) { rekeyLocked() }

    /** 解密一帧；返回它完成的消息（0 或 1 条）。调用方保证串行。 */
    fun receive(item: ChannelItem): List<JSONObject> {
        if (item.n < 0 || item.n.toULong() != receive.nonce) {
            throw ChannelProtocolException("unexpected frame counter ${item.n}, expected ${receive.nonce}")
        }
        val plaintext = try {
            receive.decryptWithAd(EMPTY, E2eeFormats.fromB64url(item.ct))
        } catch (_: NoiseException) {
            throw ChannelProtocolException("frame failed to decrypt")
        } catch (_: E2eeFormatException) {
            throw ChannelProtocolException("frame is not base64url")
        }
        val result = try {
            reassembler.push(plaintext)
        } catch (error: E2eeFormatException) {
            throw ChannelProtocolException(error.message.orEmpty(), if (error.tooLarge) E2eeErrorCodes.TOO_LARGE else E2eeErrorCodes.PROTOCOL_ERROR)
        } ?: return emptyList()
        return when (result) {
            Reassembler.Result.Rekey -> {
                receive.rekey()
                emptyList()
            }
            is Reassembler.Result.Message -> try {
                listOf(JSONObject(result.bytes.toString(Charsets.UTF_8)))
            } catch (_: JSONException) {
                throw ChannelProtocolException("channel message is not JSON")
            }
        }
    }

    fun destroy() {
        synchronized(sendLock) { send.destroy() }
        receive.destroy()
    }

    private fun rekeyLocked() {
        writeFrame(byteArrayOf(E2eeFormats.FRAME_REKEY))
        send.rekey()
        framesSinceRekey = 0
        lastRekeyMs = now()
    }

    private fun writeFrame(plaintext: ByteArray) {
        val n = send.nonce.toLong()
        val ct = send.encryptWithAd(EMPTY, plaintext)
        wire.send(ChannelItem(n, E2eeFormats.b64url(ct)))
    }

    private companion object {
        val EMPTY = ByteArray(0)
    }
}

/** 握手阶段的帧：`ct = base64url(utf8(json(HandshakeEnvelope)))`，`n = step`。 */
data class HandshakeEnvelope(
    val pattern: String,
    val pairingId: String?,
    val step: Int,
    val message: String,
) {
    fun encode(): ChannelItem {
        val json = JSONObject()
            .put("pattern", pattern)
            .put("pairingId", pairingId ?: JSONObject.NULL)
            .put("step", step)
            .put("message", message)
        return ChannelItem(step.toLong(), E2eeFormats.b64url(json.toString().toByteArray(Charsets.UTF_8)))
    }

    companion object {
        const val PAIRING = "XXpsk0"
        const val RECONNECT = "KK"

        fun decode(item: ChannelItem, expectedStep: Int): HandshakeEnvelope {
            val json = try {
                JSONObject(E2eeFormats.fromB64url(item.ct).toString(Charsets.UTF_8))
            } catch (_: Exception) {
                throw ChannelProtocolException("handshake frame is not a HandshakeEnvelope")
            }
            val pattern = json.optString("pattern")
            val step = json.optInt("step", -1)
            val message = json.opt("message")
            if (item.n != expectedStep.toLong() || step != expectedStep || (pattern != PAIRING && pattern != RECONNECT) || message !is String) {
                throw ChannelProtocolException("unexpected handshake frame")
            }
            val pairingId = if (json.isNull("pairingId")) null else json.optString("pairingId").takeIf { it.isNotEmpty() }
            return HandshakeEnvelope(pattern, pairingId, step, message)
        }
    }
}

/** 通道与隧道的错误码（contracts/e2ee/1.0 的 TunnelEndCode 加上客户端自己的码）。 */
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
