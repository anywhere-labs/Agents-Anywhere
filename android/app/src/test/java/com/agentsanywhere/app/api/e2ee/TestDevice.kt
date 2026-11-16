package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.noise.NoiseHandshake
import com.agentsanywhere.app.api.e2ee.noise.NoiseKeyPair
import com.agentsanywhere.app.api.e2ee.noise.X25519KeyPair
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 测试内的最小设备端：同一套 Noise 状态机做 responder，按契约发 `pair.committed` / `ready`，
 * 把 `request` 原样回显、给 `subscribe` 推一条事件。它也充当「Server 隧道」：[TunnelConnection]
 * 的帧直接同步地送到这里。
 */
class TestDevice(
    val deviceId: String = "dev_test",
    val identity: X25519KeyPair = com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto.generateKeyPair(),
    var now: () -> Long = { 0L },
) : TunnelConnection {
    val pairingId = "pair_test"
    val psk: ByteArray = ByteArray(32) { (it * 7 + 3).toByte() }
    val directoryKey = DirectoryKeyGrant(deviceId, "dk_1", 1, E2eeFormats.b64url(ByteArray(32) { (it + 1).toByte() }))

    /** clientId -> 钉住的客户端公钥。 */
    val grants = ConcurrentHashMap<String, ByteArray>()

    /** 设备收到的请求（JSON 文本里 `body` 的原始字节，用来核对输入摘要）。 */
    val requests = mutableListOf<JSONObject>()

    /** 改写设备 → 客户端的帧（测试篡改、丢帧）；返回 null 表示丢弃。 */
    var tamperToClient: (ChannelItem) -> ChannelItem? = { it }

    val endsFromClient = mutableListOf<String>()

    /** 设备上的文件（`fs/read` 读的内容）。 */
    val files = mutableMapOf<String, ByteArray>()
    var fileChunkLimit = TunnelFileChunk.MAX_BYTES
    val fileReads = mutableListOf<Map<String, String>>()
    val subscriptions = mutableListOf<JSONObject>()
    var terminalOutput: ByteArray = "hello".toByteArray()
    val channels = ConcurrentHashMap<String, DeviceSide>()

    fun pairingPayload(devicePub: ByteArray = identity.publicKey, expiresAt: String = "2999-01-01T00:00:00Z") = PairingPayload(
        v = 1,
        deviceId = deviceId,
        deviceIdentityPub = E2eeFormats.b64url(devicePub),
        pairingId = pairingId,
        psk = E2eeFormats.b64url(psk),
        serverUrl = "https://aa.example.com",
        e2eeMode = "required",
        expiresAt = expiresAt,
    )

    override suspend fun open(route: TunnelRoute, listener: TunnelListener): ChannelWire {
        val side = DeviceSide(route, listener)
        channels[route.ch] = side
        return object : ChannelWire {
            override fun send(item: ChannelItem) = side.fromClient(item)
            override fun end(code: String) {
                endsFromClient += code
                side.closed = true
            }
        }
    }

    inner class DeviceSide(private val route: TunnelRoute, private val listener: TunnelListener) {
        var closed = false
        private var hs: NoiseHandshake? = null
        private var pairingFlow = false
        var transport: TransportSession? = null

        private val toClient = object : ChannelWire {
            override fun send(item: ChannelItem) {
                if (closed) return
                tamperToClient(item)?.let(listener::onFrame)
            }

            override fun end(code: String) {
                if (closed) return
                closed = true
                listener.onEnd(code)
            }
        }

        /** Server 转来的 `ClientTunnelEnd`（可以伪造）。 */
        fun serverEnd(code: String) = toClient.end(code)

        /** 设备在已认证的通道里撤销这个客户端。 */
        fun revokeInChannel() {
            grants.remove(route.clientId)
            transport!!.sendMessage(JSONObject().put("kind", "close").put("reason", "revoked").put("message", E2eeErrorCodes.NOT_PAIRED))
            toClient.end(E2eeErrorCodes.NOT_PAIRED)
        }

        fun fromClient(item: ChannelItem) {
            if (closed) return
            try {
                val open = transport
                when {
                    open != null -> open.receive(item).forEach(::dispatch)
                    hs == null -> start(HandshakeEnvelope.decode(item, 0))
                    else -> finishPairing(HandshakeEnvelope.decode(item, 2))
                }
            } catch (_: NotPaired) {
                toClient.end(E2eeErrorCodes.NOT_PAIRED)
            } catch (error: ChannelProtocolException) {
                toClient.end(error.code)
            } catch (_: Exception) {
                toClient.end(E2eeErrorCodes.HANDSHAKE_FAILED)
            }
        }

        private fun start(envelope: HandshakeEnvelope) {
            if (envelope.pattern == HandshakeEnvelope.PAIRING) {
                pairingFlow = true
                val handshake = NoiseHandshake(
                    protocolName = E2eeFormats.NOISE_PAIRING_PROTOCOL,
                    initiator = false,
                    prologue = E2eeFormats.pairingPrologue(deviceId, envelope.pairingId!!, route.clientId, route.ch),
                    s = identity,
                    psks = listOf(psk),
                )
                handshake.readMessage(E2eeFormats.fromB64url(envelope.message))
                val hello = JSONObject().put("deviceId", deviceId).put("label", "Test Mac").toString().toByteArray()
                val reply = handshake.writeMessage(hello)
                hs = handshake
                toClient.send(HandshakeEnvelope(envelope.pattern, envelope.pairingId, 1, E2eeFormats.b64url(reply)).encode())
            } else {
                val pinned = grants[route.clientId] ?: throw NotPaired()
                val handshake = NoiseHandshake(
                    protocolName = E2eeFormats.NOISE_RECONNECT_PROTOCOL,
                    initiator = false,
                    prologue = E2eeFormats.connectPrologue(deviceId, route.clientId, route.ch),
                    s = identity,
                    rs = pinned,
                )
                handshake.readMessage(E2eeFormats.fromB64url(envelope.message))
                val reply = handshake.writeMessage()
                toClient.send(HandshakeEnvelope(envelope.pattern, null, 1, E2eeFormats.b64url(reply)).encode())
                open(handshake)
                sendReady()
            }
        }

        private fun finishPairing(envelope: HandshakeEnvelope) {
            val handshake = hs!!
            handshake.readMessage(E2eeFormats.fromB64url(envelope.message))
            val pair = handshake.takeTransport()
            val rs = pair.remoteStatic!!
            check(E2eeFormats.clientIdFor(rs) == route.clientId) { "client id does not match the key" }
            transport = TransportSession(pair, toClient, now)
            grants[route.clientId] = rs
            transport!!.sendMessage(
                JSONObject()
                    .put("kind", "pair.committed")
                    .put("deviceId", deviceId)
                    .put("clientId", route.clientId)
                    .put("grantedAt", "2026-11-16T00:00:00Z")
                    .put("directoryKey", JSONObject().put("deviceId", deviceId).put("keyId", directoryKey.keyId).put("epoch", directoryKey.epoch).put("key", directoryKey.key)),
            )
            sendReady()
        }

        private fun open(handshake: NoiseHandshake) {
            transport = TransportSession(handshake.takeTransport(), toClient, now)
        }

        private fun sendReady() {
            transport!!.sendMessage(
                JSONObject()
                    .put("kind", "ready")
                    .put("deviceId", deviceId)
                    .put("clientId", route.clientId)
                    .put("directoryKeyId", directoryKey.keyId)
                    .put("directoryKeyEpoch", directoryKey.epoch),
            )
        }

        private fun dispatch(message: JSONObject) {
            when (message.getString("kind")) {
                "request" -> {
                    requests += message
                    val path = message.getString("path")
                    val body: Any = when {
                        path == "/e2ee/v1/directory-key" -> JSONObject().put("deviceId", deviceId).put("keyId", directoryKey.keyId)
                            .put("epoch", directoryKey.epoch).put("key", directoryKey.key)
                        path.startsWith("/api/v2/connectors/$deviceId/fs/read?") && message.getString("method") == "GET" -> fileChunk(path)
                        message.getString("method") == "GET" && path.substringAfterLast('/') in attachments &&
                            path.contains("/attachments/") -> attachment(path.substringAfterLast('/'))
                        else -> JSONObject().put("method", message.getString("method")).put("path", path).put("echo", message.opt("body"))
                    }
                    val status = if (path == "/api/v2/missing") 404 else 200
                    transport!!.sendMessage(JSONObject().put("kind", "response").put("id", message.getString("id")).put("status", status).put("body", body))
                }
                "subscribe" -> {
                    subscriptions += message
                    val event = if (message.optString("stream") == "terminal") {
                        // One message of the normal-mode terminals-v2 stream WebSocket.
                        JSONObject().put("type", "output").put("seq", 1)
                            .put("data", java.util.Base64.getEncoder().encodeToString(terminalOutput))
                    } else {
                        JSONObject().put("type", "session.event").put("sessionId", message.getString("sessionId"))
                    }
                    transport!!.sendMessage(JSONObject().put("kind", "event").put("sub", message.getString("id")).put("event", event))
                }
                "unsubscribe" -> Unit
                "close" -> closed = true
            }
        }
    }

    /** 会话附件（`GET /sessions/{id}/attachments/{fileId}` 的回答，与普通模式同一形状）。 */
    val attachments = mutableMapOf<String, ByteArray>()

    private fun attachment(fileId: String): JSONObject {
        val bytes = attachments.getValue(fileId)
        return JSONObject()
            .put("fileId", fileId)
            .put("name", "$fileId.png")
            .put("size", bytes.size)
            .put("sha256", E2eeFormats.hex(com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto.sha256(bytes)))
            .put("contentBase64", java.util.Base64.getEncoder().encodeToString(bytes))
    }

    /** `fs/read?path&offset&length` → `TunnelFileChunk`；每块最多 [fileChunkLimit] 字节。 */
    private fun fileChunk(path: String): JSONObject {
        val query = path.substringAfter('?').split('&').associate {
            it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8")
        }
        val bytes = files.getValue(query.getValue("path"))
        val offset = query.getValue("offset").toInt()
        val length = minOf(query.getValue("length").toInt(), fileChunkLimit, TunnelFileChunk.MAX_BYTES)
        val end = minOf(bytes.size, offset + length)
        fileReads += query
        return JSONObject()
            .put("encoding", "base64")
            .put("data", java.util.Base64.getEncoder().encodeToString(bytes.copyOfRange(offset, end)))
            .put("offset", offset)
            .put("size", bytes.size)
            .put("eof", end >= bytes.size)
    }

    /**
     * 设备这边取回加密附件：按 64 KiB + 16 切段，用请求体里的 `sealedAttachmentKeys` 解密，
     * 核对 `size` 与 `sha256`（也是分段 AD 的 objectId）。
     */
    fun openSealedAttachment(ciphertext: ByteArray, sealedKey: JSONObject): ByteArray {
        val step = E2eeFormats.SEALED_SEGMENT_BYTES + 16
        val segments = (0 until maxOf(1, (ciphertext.size + step - 1) / step)).map { index ->
            ciphertext.copyOfRange(index * step, minOf(ciphertext.size, (index + 1) * step))
        }
        val sha256 = sealedKey.getString("sha256")
        val plaintext = E2eeFormats.openSegments(SealedPurpose.Attachment, sha256, E2eeFormats.fromB64url(sealedKey.getString("key")), segments)
        check(plaintext.size.toLong() == sealedKey.getLong("size")) { "size mismatch" }
        check(E2eeFormats.hex(com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto.sha256(plaintext)) == sha256) { "sha256 mismatch" }
        return plaintext
    }

    private class NotPaired : Exception()
}

/** 不关心配对的测试用的身份。 */
fun testIdentity(seed: Int): NoiseKeyPair = X25519KeyPair.fromSecret(ByteArray(32) { (it + seed).toByte() })

/** 结构相等（android.jar 的 JSONObject 编译期没有 `similar`）。 */
fun jsonSimilar(a: Any?, b: Any?): Boolean = when {
    a is JSONObject && b is JSONObject ->
        a.keys().asSequence().toSet() == b.keys().asSequence().toSet() && a.keys().asSequence().all { jsonSimilar(a.opt(it), b.opt(it)) }
    a is org.json.JSONArray && b is org.json.JSONArray ->
        a.length() == b.length() && (0 until a.length()).all { jsonSimilar(a.opt(it), b.opt(it)) }
    a is Number && b is Number -> a.toDouble() == b.toDouble()
    else -> a == b
}
