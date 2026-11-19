package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.E2eeServerConfig
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.TerminalApi
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.api.e2ee.ContentTarget
import com.agentsanywhere.app.api.e2ee.DeviceContent
import com.agentsanywhere.app.api.e2ee.E2eeClientErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeContentPaths
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.e2ee.SessionDeviceDirectory
import com.agentsanywhere.app.api.e2ee.TestDevice
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 按设备选择传输：哪些请求照常走明文（打到 MockWebServer），哪些经测试设备的安全通道，哪些被拒绝；
 * 以及事件流、命令登记和统一超时。
 */
class E2eeContentRoutingTest {
    private class Sealer : SecretSealer {
        private val key = ByteArray(32) { 3 }
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

    private val server = MockWebServer()
    private val device = TestDevice(deviceId = "dev_paired")
    private val trust = ClientTrustStore(InMemoryTrustStorage(), Sealer())
    private val registered = mutableListOf<String>()
    private val digests = mutableListOf<String>()
    private var duplicate = false
    private var serverConfig = E2eeServerConfig()
    private val sessionDevices = mutableMapOf("sess_paired" to "dev_paired", "sess_other" to "dev_other")
    private var timeoutMillis = E2eeClient.DEFAULT_REQUEST_TIMEOUT_MS

    private val e2ee by lazy {
        E2eeClient(
            trust = trust,
            provider = LegacyE2eeProvider(trust, device),
            commands = { commandId, _, digest ->
                registered += commandId
                digests += digest
                duplicate
            },
            loadServerConfig = { serverConfig },
            requestTimeoutMillis = timeoutMillis,
        )
    }
    private val router by lazy { E2eeContentRouter(e2ee, resolveSessionDevice = { _, _, id -> sessionDevices[id] }) }
    private val apiClient by lazy { ApiClient(contentGate = { router }) }
    private val serverUrl by lazy { server.url("/").toString().trimEnd('/') }

    @Before
    fun setUp() {
        SessionDeviceDirectory.clear()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        SessionDeviceDirectory.clear()
    }

    private fun json(body: String = "{}") = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    private fun pairDevice() = runBlocking { e2ee.pair(device.pairingPayload(), label = "Pixel") }

    private fun expectRefused(code: String, block: () -> Unit) {
        try {
            block()
        } catch (error: ApiException) {
            assertEquals(code, error.errorCode)
            return
        }
        fail("expected $code")
    }

    @Test
    fun classifiesContentPaths() {
        assertEquals(ContentTarget.Session("s1"), E2eeContentPaths.classify("/sessions/s1/snapshot?limit=50"))
        assertEquals(ContentTarget.Session("s1"), E2eeContentPaths.classify("/api/v2/sessions/s1/runtime/messages"))
        assertEquals(ContentTarget.Session("s1"), E2eeContentPaths.classify("/sessions/s1/runtime/queue/m1/send-now"))
        assertEquals(ContentTarget.Session("s 1"), E2eeContentPaths.classify("/sessions/s%201/timeline"))
        assertEquals(ContentTarget.Session("s1"), E2eeContentPaths.classify("/runtime-workflows/sessions/s1/recover"))
        assertNull(E2eeContentPaths.classify("/runtime-workflows/preparations"))
        assertNull(E2eeContentPaths.classify("/sessions/s1/meta"))
        assertEquals(ContentTarget.Session("s1"), E2eeContentPaths.classify("/sessions/s1/runtime/state"))
        assertEquals(ContentTarget.Session("s1"), E2eeContentPaths.classify("/sessions/s1/runtime/capabilities"))
        assertNull(E2eeContentPaths.classify("/sessions/archive"))
        assertNull(E2eeContentPaths.classify("/sessions?limit=20"))
        assertNull(E2eeContentPaths.classify("/ws-ticket"))
        assertEquals(ContentTarget.Device("d1", DeviceContent.Files), E2eeContentPaths.classify("/connectors/d1/fs/list"))
        assertEquals(ContentTarget.Device("d1", DeviceContent.FileTransfer), E2eeContentPaths.classify("/connectors/d1/fs/read?root=x"))
        assertEquals(ContentTarget.Device("d1", DeviceContent.Terminal), E2eeContentPaths.classify("/connectors/d1/terminals-v2?root=x"))
        assertNull(E2eeContentPaths.classify("/connectors/d1/settings"))
    }

    @Test
    fun withoutEncryptionEverythingStaysPlain() {
        server.enqueue(json("""{"items":[]}"""))
        apiClient.getJson(serverUrl, "/sessions/sess_other/snapshot?limit=50", "token")
        assertEquals("/api/v2/sessions/sess_other/snapshot?limit=50", server.takeRequest().path)
        assertTrue(device.channels.isEmpty())
    }

    @Test
    fun pairedDeviceContentGoesThroughTheChannel() {
        pairDevice()
        val snapshot = apiClient.getJson(serverUrl, "/sessions/sess_paired/snapshot?limit=50", "token")
        assertEquals("/api/v2/sessions/sess_paired/snapshot?limit=50", snapshot.getString("path"))
        assertEquals("GET", snapshot.getString("method"))

        // `meta` stays on the Server (it is how the client learns the session's device).
        server.enqueue(json("""{"ok":true}"""))
        apiClient.getJson(serverUrl, "/sessions/sess_paired/meta", "token")
        assertEquals("/api/v2/sessions/sess_paired/meta", server.takeRequest().path)

        // Files list goes through the channel too.
        FilesApi(apiClient).listFiles(serverUrl, "token", "dev_paired", root = "r", path = ".")
        assertEquals("/api/v2/connectors/dev_paired/fs/list", device.requests.last().getString("path"))

        // An unpaired device on an instance without encryption stays plain.
        server.enqueue(json("""{"items":[]}"""))
        apiClient.getJson(serverUrl, "/sessions/sess_other/timeline", "token")
        assertEquals("/api/v2/sessions/sess_other/timeline", server.takeRequest().path)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun messagesAreRegisteredCommandsAndDuplicatesAreNotResent() {
        pairDevice()
        val sessions = SessionsApi(apiClient)
        sessions.sendSessionMessage(serverUrl, "token", "sess_paired", content = "hello", clientMessageId = "m_1")
        assertEquals(listOf("m_1"), registered)
        val sent = device.requests.last()
        assertEquals("/api/v2/sessions/sess_paired/runtime/messages", sent.getString("path"))
        assertEquals("hello", sent.getJSONObject("body").getString("content"))

        duplicate = true
        val before = device.requests.size
        val response = sessions.sendSessionMessage(serverUrl, "token", "sess_paired", content = "hello", clientMessageId = "m_1")
        assertTrue(response.ok)
        assertEquals(before, device.requests.size)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun pairingRequiredNeverFallsBackToPlaintext() {
        serverConfig = E2eeServerConfig(mode = E2eeServerConfig.MODE_REQUIRED)
        runBlocking { e2ee.refreshServerConfig() }
        expectRefused(E2eeErrorCodes.E2EE_REQUIRED) {
            SessionsApi(apiClient).sendSessionMessage(serverUrl, "token", "sess_other", content = "secret", clientMessageId = "m_2")
        }
        assertEquals("dev_other", e2ee.pairingPrompt.value)
        // A session whose device cannot be resolved is refused too.
        expectRefused(E2eeErrorCodes.E2EE_REQUIRED) { apiClient.getJson(serverUrl, "/sessions/sess_unknown/snapshot", "token") }
        expectRefused(E2eeErrorCodes.E2EE_REQUIRED) {
            FilesApi(apiClient).listFiles(serverUrl, "token", "dev_other", root = "r")
        }
        assertEquals(0, server.requestCount)
        assertTrue(registered.isEmpty())

        // Dismissed prompts stay dismissed for this process.
        e2ee.dismissPairingPrompt("dev_other")
        assertNull(e2ee.pairingPrompt.value)
        expectRefused(E2eeErrorCodes.E2EE_REQUIRED) { apiClient.getJson(serverUrl, "/sessions/sess_other/snapshot", "token") }
        assertNull(e2ee.pairingPrompt.value)
    }

    @Test
    fun encryptedDevicesNeverFallBackToPlaintextTransfers() {
        pairDevice()
        // This router has no sealed uploader: the attachment is refused rather than uploaded in plaintext.
        expectRefused(E2eeClientErrorCodes.ATTACHMENTS_UNSUPPORTED) {
            SessionsApi(apiClient).uploadSessionAttachments(serverUrl, "token", "sess_paired", listOf(UploadFilePart("a.txt", "text/plain", ByteArray(3))))
        }
        // The normal-mode transfer (`POST fs/read`) would pass the Server in plaintext.
        expectRefused(E2eeClientErrorCodes.FILE_TRANSFER_UNSUPPORTED) {
            apiClient.postJson(serverUrl, "/connectors/dev_paired/fs/read?root=r", JSONObject().put("path", "a.bin"), "token")
        }
        // Terminal management goes through the channel.
        // (The test device echoes instead of listing; only the route matters here.)
        runCatching { TerminalApi(apiClient).listTerminals(serverUrl, "token", "dev_paired") }
        assertEquals("/api/v2/connectors/dev_paired/terminals-v2", device.requests.last().getString("path"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aSilentDeviceTimesOutWithARecognizableCode() {
        timeoutMillis = 300
        pairDevice()
        device.tamperToClient = { null }
        try {
            apiClient.getJson(serverUrl, "/sessions/sess_paired/snapshot", "token")
            fail("expected a timeout")
        } catch (error: ApiException) {
            assertEquals(E2eeClientErrorCodes.TIMEOUT, error.errorCode)
            assertEquals(504, error.statusCode)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aServerRelayedEndSurfacesAsAnErrorWithoutTouchingThePin() {
        pairDevice()
        device.channels.values.last().serverEnd(E2eeErrorCodes.NOT_PAIRED)
        device.grants.clear()
        expectRefused(E2eeErrorCodes.NOT_PAIRED) { apiClient.getJson(serverUrl, "/sessions/sess_paired/snapshot", "token") }
        assertNotNull(trust.device("dev_paired"))
        assertEquals("dev_paired", e2ee.pairingPrompt.value)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun sessionEventsStreamThroughTheChannel() = runBlocking<Unit> {
        assertNull(router.openSecureStream(serverUrl, "token", "sess_other", null, {}, {}))
        pairDevice()
        val messages = mutableListOf<String>()
        var closed = false
        val stop = router.openSecureStream(serverUrl, "token", "sess_paired", "seq:4", { messages += it }, { closed = true })
        assertNotNull(stop)
        val subscribe = device.channels.values.last()
        assertEquals(1, messages.size)
        assertEquals("sess_paired", JSONObject(messages.single()).getString("sessionId"))
        stop!!()
        subscribe.serverEnd(E2eeErrorCodes.CONNECTOR_OFFLINE)
        assertTrue(closed)
    }

    @Test
    fun commandDigestUsesTheExactBodyBytes() {
        pairDevice()
        val body = JSONObject().put("content", "hi").put("clientMessageId", "m_9")
        apiClient.postJson(serverUrl, "/sessions/sess_paired/runtime/steer", body, "token")
        assertEquals(listOf("m_9"), registered)
        // The digest covers exactly the body text ApiClient would have sent, which is what the channel carries.
        val key = trust.directoryKey("dev_paired")!!.keyBytes
        assertEquals(E2eeFormats.inputDigest(key, body.toString().toByteArray()), digests.single())
        assertEquals("hi", device.requests.last().getJSONObject("body").getString("content"))
    }
}
