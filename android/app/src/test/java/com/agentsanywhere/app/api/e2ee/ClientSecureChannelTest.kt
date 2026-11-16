package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto
import com.agentsanywhere.app.api.e2ee.noise.NoiseKeyPair
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 客户端通道与测试内最小设备端的往返：配对、重连、rekey、设备公钥不符、篡改密文。 */
class ClientSecureChannelTest {
    private val clientIdentity = NoiseCrypto.generateKeyPair()

    private suspend fun pair(
        device: TestDevice,
        payload: PairingPayload = device.pairingPayload(),
        identity: NoiseKeyPair = clientIdentity,
        now: () -> Long = { 0L },
    ): PairResult {
        val ch = ClientSecureChannel.newChannelId()
        val binding = ChannelBinding()
        val wire = device.open(TunnelRoute(payload.deviceId, E2eeFormats.clientIdFor(identity.publicKey), ch), binding)
        return ClientSecureChannel.pair(payload, identity, ch, wire, label = "Pixel", now = now, bind = binding::bind)
    }

    private suspend fun connect(
        device: TestDevice,
        devicePub: ByteArray = device.identity.publicKey,
        identity: NoiseKeyPair = clientIdentity,
        now: () -> Long = { 0L },
    ): ClientSecureChannel {
        val ch = ClientSecureChannel.newChannelId()
        val binding = ChannelBinding()
        val wire = device.open(TunnelRoute(device.deviceId, E2eeFormats.clientIdFor(identity.publicKey), ch), binding)
        return ClientSecureChannel.connect(device.deviceId, devicePub, identity, ch, wire, now, binding::bind)
    }

    private suspend fun expectClosed(code: String, block: suspend () -> Unit): ChannelClosedException {
        try {
            block()
        } catch (error: ChannelClosedException) {
            assertEquals(code, error.code)
            return error
        }
        fail("expected $code")
        throw AssertionError()
    }

    @Test
    fun pairsThenRequestsAndSubscribes() = runBlocking<Unit> {
        val device = TestDevice()
        val result = pair(device)
        assertEquals("2026-11-16T00:00:00Z", result.grantedAt)
        assertEquals(device.directoryKey, result.directoryKey)
        val channel = result.channel
        assertTrue(channel.isOpen)
        assertEquals("dk_1", channel.ready!!.directoryKeyId)
        assertNotNull(device.grants[E2eeFormats.clientIdFor(clientIdentity.publicKey)])

        val response = channel.request("POST", "/api/v2/sessions/s1/messages", """{"content":"hello","clientMessageId":"m_1"}""")
        assertEquals(200, response.status)
        assertEquals("hello", response.bodyObject()!!.getJSONObject("echo").getString("content"))

        val json = channel.requestJson("GET", "/sessions/s1/snapshot")
        assertEquals("/api/v2/sessions/s1/snapshot", json.getString("path"))
        try {
            channel.requestJson("GET", "/missing")
            fail("expected 404")
        } catch (error: ApiException) {
            assertEquals(404, error.statusCode)
        }

        val events = mutableListOf<JSONObject>()
        val sub = channel.subscribe("s1", "seq:3", events::add)
        assertEquals(1, events.size)
        assertEquals("s1", events.single().getString("sessionId"))
        channel.unsubscribe(sub)
        channel.close()
        assertEquals(E2eeErrorCodes.CLOSED, channel.closed!!.code)
    }

    @Test
    fun reconnectsWithKk() = runBlocking<Unit> {
        val device = TestDevice()
        pair(device).channel.close()
        val channel = connect(device)
        assertTrue(channel.isOpen)
        assertEquals(200, channel.request("GET", "/api/v2/sessions").status)
    }

    @Test
    fun rekeysByTimeAndOnDemand() = runBlocking<Unit> {
        val device = TestDevice()
        var clock = 0L
        val channel = connect(device.also { pair(it).channel.close() }, now = { clock })
        val before = channel.sendNonce
        assertEquals(200, channel.request("GET", "/api/v2/a").status)
        assertEquals(before + 1u, channel.sendNonce)

        // One hour later the next message is preceded by a rekey frame; the device follows it.
        clock += E2eeFormats.REKEY_INTERVAL_MS
        assertEquals(200, channel.request("GET", "/api/v2/b").status)
        assertEquals(before + 3u, channel.sendNonce)

        channel.rekeyNow()
        assertEquals(200, channel.request("GET", "/api/v2/c").status)

        // The device rekeys its own direction too; the client follows the 0x02 frame.
        device.channels.values.last().transport!!.rekeyNow()
        assertEquals(200, channel.request("GET", "/api/v2/d").status)
        assertTrue(channel.isOpen)
    }

    @Test
    fun largeMessagesAreFragmented() = runBlocking<Unit> {
        val device = TestDevice()
        val channel = pair(device).channel
        val big = "x".repeat(200_000)
        val response = channel.request("POST", "/api/v2/big", JSONObject().put("text", big).toString())
        assertEquals(big, response.bodyObject()!!.getJSONObject("echo").getString("text"))
    }

    @Test
    fun pairingRejectsADeviceKeyThatIsNotInTheQrCode() = runBlocking<Unit> {
        val device = TestDevice()
        val forged = device.pairingPayload(devicePub = NoiseCrypto.generateKeyPair().publicKey)
        expectClosed(E2eeErrorCodes.DEVICE_PIN_MISMATCH) { pair(device, forged) }
        assertTrue(device.grants.isEmpty())
    }

    @Test
    fun reconnectRejectsAChangedDeviceKey() = runBlocking<Unit> {
        val device = TestDevice()
        pair(device).channel.close()
        // The pinned key is no longer the device's: it cannot answer KK.
        expectClosed(E2eeErrorCodes.DEVICE_PIN_MISMATCH) { connect(device, devicePub = NoiseCrypto.generateKeyPair().publicKey) }
        // A different device identity behind the same id (e.g. a relay swapping devices).
        val impostor = TestDevice(deviceId = device.deviceId).apply { grants.putAll(device.grants) }
        expectClosed(E2eeErrorCodes.DEVICE_PIN_MISMATCH) { connect(impostor, devicePub = device.identity.publicKey) }
    }

    @Test
    fun wrongPskFailsTheHandshake() = runBlocking<Unit> {
        val device = TestDevice()
        val payload = device.pairingPayload().copy(psk = E2eeFormats.b64url(ByteArray(32)))
        expectClosed(E2eeErrorCodes.HANDSHAKE_FAILED) { pair(device, payload) }
        assertTrue(device.grants.isEmpty())
    }

    @Test
    fun unknownClientIsNotPaired() = runBlocking<Unit> {
        val device = TestDevice()
        val error = expectClosed(E2eeErrorCodes.NOT_PAIRED) { connect(device) }
        assertFalse(error.fromDevice)
    }

    @Test
    fun tamperedCiphertextClosesTheChannel() = runBlocking<Unit> {
        val device = TestDevice()
        val channel = pair(device).channel
        device.tamperToClient = { item ->
            val bytes = E2eeFormats.fromB64url(item.ct)
            bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0x01).toByte()
            item.copy(ct = E2eeFormats.b64url(bytes))
        }
        expectClosed(E2eeErrorCodes.PROTOCOL_ERROR) { channel.request("GET", "/api/v2/sessions") }
        assertEquals(E2eeErrorCodes.PROTOCOL_ERROR, device.endsFromClient.last())
    }

    @Test
    fun aSkippedFrameClosesTheChannel() = runBlocking<Unit> {
        val device = TestDevice()
        val channel = pair(device).channel
        var dropped = false
        device.tamperToClient = { item -> if (!dropped) { dropped = true; null } else item }
        // The first response is dropped, so the second arrives with the wrong counter.
        val first = async { runCatching { channel.request("GET", "/api/v2/one") } }
        expectClosed(E2eeErrorCodes.PROTOCOL_ERROR) { channel.request("GET", "/api/v2/two") }
        assertTrue(first.await().isFailure)
    }

    @Test
    fun serverEndIsNotADeviceRevocation() = runBlocking<Unit> {
        val device = TestDevice()
        val channel = pair(device).channel
        device.channels.values.last().serverEnd(E2eeErrorCodes.NOT_PAIRED)
        val closed = channel.closed!!
        assertEquals(E2eeErrorCodes.NOT_PAIRED, closed.code)
        assertFalse(closed.fromDevice)
    }

    @Test
    fun inChannelRevocationComesFromTheDevice() = runBlocking<Unit> {
        val device = TestDevice()
        val channel = pair(device).channel
        device.channels.values.last().revokeInChannel()
        val closed = channel.closed!!
        assertEquals(E2eeErrorCodes.NOT_PAIRED, closed.code)
        assertTrue(closed.fromDevice)
        assertNull(channel.ready)
    }
}
