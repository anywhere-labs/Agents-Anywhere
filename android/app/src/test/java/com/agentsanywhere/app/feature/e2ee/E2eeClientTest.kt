package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.E2eeServerConfig
import com.agentsanywhere.app.api.e2ee.ChannelClosedException
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.e2ee.TestDevice
import com.agentsanywhere.app.api.e2ee.jsonSimilar
import com.agentsanywhere.app.api.toE2eeServerConfig
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Client Trust 存储、按设备选择传输、降级保护，以及 [E2eeClient] 经测试设备的配对与命令。 */
class E2eeClientTest {
    /** 测试里代替 Android Keystore 的包裹：同样是 AES-GCM，只是密钥在内存里。 */
    private class TestSealer(private val key: ByteArray = ByteArray(32) { 9 }) : SecretSealer {
        override fun seal(plaintext: ByteArray): ByteArray {
            val iv = ByteArray(12).also(java.security.SecureRandom()::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            return iv + cipher.doFinal(plaintext)
        }

        override fun open(sealed: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed, 0, 12))
            return cipher.doFinal(sealed, 12, sealed.size - 12)
        }
    }

    private val storage = InMemoryTrustStorage()
    private val trust = ClientTrustStore(storage, TestSealer())
    private val registered = mutableListOf<Triple<String, String, String>>()
    private var duplicate = false
    private var server = E2eeServerConfig()

    private fun client(device: TestDevice) = E2eeClient(
        trust = trust,
        provider = LegacyE2eeProvider(trust, device),
        commands = { commandId, deviceId, digest ->
            registered += Triple(commandId, deviceId, digest)
            duplicate
        },
        loadServerConfig = { server },
    )

    @Test
    fun identityIsStableAndWrapped() {
        val id = trust.clientId()
        assertTrue(E2eeFormats.isClientId(id))
        assertEquals(id, ClientTrustStore(storage, TestSealer()).clientId())
        // The stored identity is sealed, not the raw secret.
        val stored = E2eeFormats.fromB64url(storage.read("identity")!!)
        assertNotEquals(32, stored.size)
        // A lost wrapping key (restore onto another phone) yields a new identity.
        assertNotEquals(id, ClientTrustStore(storage, TestSealer(ByteArray(32) { 1 })).clientId())
    }

    @Test
    fun pairsSavesTheGrantAndReconnects() = runBlocking<Unit> {
        val device = TestDevice()
        val client = client(device)
        assertEquals(DeviceTransport.Plain, client.transportFor(device.deviceId))

        val record = client.pair(device.pairingPayload(), label = "Pixel")
        assertEquals(E2eeFormats.fingerprint(device.identity.publicKey), record.deviceFingerprint)
        assertEquals("dk_1", record.directoryKeyId)
        assertEquals(device.directoryKey.key, trust.directoryKey(device.deviceId)!!.key)
        assertTrue(trust.requiresEncryption(device.deviceId))
        assertTrue(client.transportFor(device.deviceId) is DeviceTransport.Secure)

        val snapshot = client.request(device.deviceId, "GET", "/sessions/s1/snapshot")
        assertEquals("/api/v2/sessions/s1/snapshot", snapshot.getString("path"))

        // A fresh client (app restart) reconnects with KK from the stored pin.
        client.closeAll()
        val restarted = client(device)
        assertEquals("/api/v2/sessions", restarted.request(device.deviceId, "GET", "/sessions").getString("path"))
        assertTrue(restarted.channel(device.deviceId).isOpen)
    }

    @Test
    fun commandsAreRegisteredWithTheInputDigestFirst() = runBlocking<Unit> {
        val device = TestDevice()
        val client = client(device)
        client.pair(device.pairingPayload(), label = "Pixel")
        val body = """{"content":"hello","clientMessageId":"m_1"}"""
        val response = client.sendCommand(device.deviceId, "m_1", "POST", "/sessions/s1/messages", body)
        assertEquals(200, response.status)
        val (commandId, deviceId, digest) = registered.single()
        assertEquals("m_1", commandId)
        assertEquals(device.deviceId, deviceId)
        assertEquals(E2eeFormats.inputDigest(device.directoryKey.keyBytes, body.toByteArray()), digest)
        // The device receives exactly the bytes the digest covers.
        val sent = device.requests.last()
        assertEquals("/api/v2/sessions/s1/messages", sent.getString("path"))
        assertTrue(jsonSimilar(JSONObject(body), sent.getJSONObject("body")))

        duplicate = true
        val before = device.requests.size
        val replay = client.sendCommand(device.deviceId, "m_1", "POST", "/sessions/s1/messages", body)
        assertEquals(200, replay.status)
        assertEquals(before + 1, device.requests.size)
        assertTrue(jsonSimilar(sent.getJSONObject("body"), device.requests.last().getJSONObject("body")))
        assertEquals(registered.first(), registered.last())
    }

    @Test
    fun aServerRelayedNotPairedLeavesThePin() = runBlocking<Unit> {
        val device = TestDevice()
        val client = client(device)
        client.pair(device.pairingPayload(), label = "Pixel")
        // The Server ends the open channel claiming the device revoked us.
        device.channels.values.last().serverEnd(E2eeErrorCodes.NOT_PAIRED)
        assertNotNull(trust.device(device.deviceId))

        // On reconnect the Server (or the device, before the handshake) says not paired: still only a report.
        device.grants.clear()
        try {
            client.channel(device.deviceId)
            fail("expected not paired")
        } catch (error: ChannelClosedException) {
            assertEquals(E2eeErrorCodes.NOT_PAIRED, error.code)
            assertFalse(error.fromDevice)
        }
        assertNotNull(trust.device(device.deviceId))
    }

    @Test
    fun anInChannelRevocationDropsThePinButKeepsEncryptionRequired() = runBlocking<Unit> {
        val device = TestDevice()
        val client = client(device)
        client.pair(device.pairingPayload(), label = "Pixel")
        device.channels.values.last().revokeInChannel()
        assertNull(trust.device(device.deviceId))
        assertNull(trust.directoryKey(device.deviceId))
        // Downgrade protection: the Server saying "off" does not let this device go back to plaintext.
        server = E2eeServerConfig(mode = E2eeServerConfig.MODE_OFF)
        client.refreshServerConfig()
        assertEquals(DeviceTransport.PairingRequired(device.deviceId), client.transportFor(device.deviceId))
    }

    @Test
    fun aServerOnceRequiringEncryptionCannotRelaxUnpairedDevices() = runBlocking<Unit> {
        val device = TestDevice()
        val client = client(device)
        server = E2eeServerConfig(mode = E2eeServerConfig.MODE_REQUIRED)
        client.refreshServerConfig()
        assertEquals(DeviceTransport.PairingRequired("never_paired"), client.transportFor("never_paired"))
        // The Server (or someone in its place) now says "off": this client still refuses plaintext.
        server = E2eeServerConfig(mode = E2eeServerConfig.MODE_OFF)
        client.refreshServerConfig()
        assertEquals(DeviceTransport.PairingRequired("never_paired"), client.transportFor("never_paired"))
        // Only a local action relaxes it.
        trust.relaxInstanceLocally()
        assertEquals(DeviceTransport.Plain, client.transportFor("never_paired"))
    }

    @Test
    fun transportPolicy() {
        val required = E2eeServerConfig(mode = E2eeServerConfig.MODE_REQUIRED)
        val off = E2eeServerConfig()
        assertEquals(DeviceTransport.Plain, E2eeTransportPolicy.select("d", off, null, locallyRequired = false))
        assertEquals(DeviceTransport.PairingRequired("d"), E2eeTransportPolicy.select("d", required, null, locallyRequired = false))
        assertEquals(DeviceTransport.PairingRequired("d"), E2eeTransportPolicy.select("d", off, null, locallyRequired = true))
        val paired = PairedDevice("d", "cli_x", "pub", "fp", "t", "k", 1)
        assertEquals(DeviceTransport.Secure(paired), E2eeTransportPolicy.select("d", off, paired, locallyRequired = false))
    }

    @Test
    fun authConfigWithoutE2eeIsOff() {
        assertFalse(null.toE2eeServerConfig().required)
        assertFalse(JSONObject().put("mode", "weird").toE2eeServerConfig().required)
        val config = JSONObject().put("mode", "required").put("web", "deny").put("preview", "deny").toE2eeServerConfig()
        assertTrue(config.required)
        assertEquals(E2eeServerConfig.DENY, config.web)
        assertFalse(config.previewAllowed)
        assertTrue(JSONObject().put("mode", "required").toE2eeServerConfig().previewAllowed)
    }

    @Test
    fun expiredQrCodesAreRefusedLocally() = runBlocking<Unit> {
        val device = TestDevice()
        try {
            client(device).pair(device.pairingPayload(expiresAt = "1970-01-01T00:00:00Z"), label = "Pixel")
            fail("expected pairing_expired")
        } catch (error: ChannelClosedException) {
            assertEquals(E2eeErrorCodes.PAIRING_EXPIRED, error.code)
        }
        assertTrue(device.channels.isEmpty())
    }

    @Test
    fun aDirectoryKeyRotationIsStored() {
        val device = TestDevice()
        runBlocking { client(device).pair(device.pairingPayload(), label = "Pixel") }
        val rotated = device.directoryKey.copy(keyId = "dk_2", epoch = 2, key = E2eeFormats.b64url(ByteArray(32) { 5 }))
        assertTrue(trust.updateDirectoryKey(rotated))
        assertEquals("dk_2", trust.device(device.deviceId)!!.directoryKeyId)
        assertFalse(trust.updateDirectoryKey(device.directoryKey))
        assertEquals(rotated.key, trust.directoryKey(device.deviceId)!!.key)
    }

    private fun uriFor(payload: com.agentsanywhere.app.api.e2ee.PairingPayload) =
        "aa-pair://" + E2eeFormats.b64url(payload.toJson().toString().toByteArray())

    @Test
    fun pairingStateChecksTheLinkAndTheDevice() {
        val device = TestDevice()
        val uri = uriFor(device.pairingPayload())
        assertEquals(E2eePairingError.InvalidLink, E2eePairingState().linkEntered("hello", device.deviceId).error)
        assertEquals(E2eePairingError.WrongDevice, E2eePairingState().linkEntered(uri, "dev_other").error)
        val confirm = E2eePairingState().linkEntered(uri, device.deviceId)
        assertEquals(E2eePairingState.Stage.Confirm, confirm.stage)
        assertEquals(E2eeFormats.fingerprint(device.identity.publicKey), confirm.deviceFingerprint)
        val paired = runBlocking { client(device).pairForState(confirm.started(), "Pixel", "2.2.0") }
        assertEquals(E2eePairingState.Stage.Paired, paired.stage)

        // A QR code whose device key is not the device's own: back to scanning with a pin mismatch.
        val other = TestDevice()
        val forged = E2eePairingState().linkEntered(uriFor(other.pairingPayload(devicePub = device.identity.publicKey)), other.deviceId)
        val failed = runBlocking { client(other).pairForState(forged.started(), "Pixel", null) }
        assertEquals(E2eePairingError.DevicePinMismatch, failed.error)
        assertEquals(E2eePairingState.Stage.Scan, failed.stage)
    }
}
