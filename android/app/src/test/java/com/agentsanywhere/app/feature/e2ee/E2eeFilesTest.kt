package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.RemoteAttachmentRef
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.api.e2ee.DeferredStartSocket
import com.agentsanywhere.app.api.e2ee.E2eeClientErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.e2ee.SealedUpload
import com.agentsanywhere.app.api.e2ee.SessionDeviceDirectory
import com.agentsanywhere.app.api.e2ee.TestDevice
import com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto
import com.agentsanywhere.app.feature.sessiondetail.SessionAttachmentTransfer
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 加密设备上的分块文件下载、加密附件、终端订阅、新建会话的第一条消息、附件图片与退出登录。 */
class E2eeFilesTest {
    @get:Rule
    val temp = TemporaryFolder()

    private class Sealer : SecretSealer {
        private val key = ByteArray(32) { 7 }
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
    private val registered = CopyOnWriteArrayList<String>()
    @Volatile private var duplicateCommands = false
    private val serverRequests = CopyOnWriteArrayList<Pair<RecordedRequest, ByteArray>>()

    private val e2ee by lazy {
        E2eeClient(trust, device, { commandId, _, _ -> registered += commandId; duplicateCommands }, { com.agentsanywhere.app.api.E2eeServerConfig() }, { 0L })
    }
    private lateinit var router: E2eeContentRouter
    private val apiClient by lazy { ApiClient(contentGate = { router }) }
    private val serverUrl by lazy { server.url("/").toString().trimEnd('/') }

    @Before
    fun setUp() {
        SessionDeviceDirectory.clear()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readByteArray()
                serverRequests += request to body
                val json = when {
                    request.path!!.endsWith("/attachments") -> uploadResponse(request, body)
                    request.path!!.endsWith("/sessions/create-and-start") -> JSONObject().put("session", JSONObject().put("id", "sess_new"))
                    else -> JSONObject()
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(json.toString())
            }
        }
        server.start()
        router = E2eeContentRouter(
            client = e2ee,
            resolveSessionDevice = { _, _, id -> if (id.startsWith("sess_")) "dev_paired" else null },
            sealedUploader = { url, token, path, files, headers -> apiClient.postMultipart(url, path, files, token, headers) },
        )
        runBlocking { e2ee.pair(device.pairingPayload(), label = "Pixel") }
    }

    @After
    fun tearDown() {
        server.shutdown()
        SessionDeviceDirectory.clear()
    }

    /** The Server stores whatever it receives: here, the ciphertext of the multipart file part. */
    private fun uploadResponse(request: RecordedRequest, body: ByteArray): JSONObject {
        val ciphertext = multipartFile(request, body)
        return JSONObject().put(
            "attachments",
            JSONArray().put(
                JSONObject().put("fileId", "file_1").put("name", "notes.bin").put("mediaType", "application/octet-stream")
                    .put("size", ciphertext.size).put("sha256", E2eeFormats.hex(NoiseCrypto.sha256(ciphertext))),
            ),
        )
    }

    private fun multipartFile(request: RecordedRequest, body: ByteArray): ByteArray {
        val boundary = request.getHeader("Content-Type")!!.substringAfter("boundary=")
        val start = indexOf(body, "\r\n\r\n".toByteArray()) + 4
        val end = indexOf(body, "\r\n--$boundary--".toByteArray())
        return body.copyOfRange(start, end)
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return i
        }
        error("not found")
    }

    @Test
    fun filesDownloadInChunksThroughTheChannel() {
        val content = ByteArray(1000) { (it * 13).toByte() }
        device.files["docs/big.bin"] = content
        device.fileChunkLimit = 300
        val files = FilesApi(apiClient)
        val transfer = files.prepareFile(serverUrl, "token", "dev_paired", root = "ws", path = "docs/big.bin")
        assertEquals(1000L, transfer.size)
        assertEquals("big.bin", transfer.name)
        val progress = mutableListOf<Long>()
        val saved = files.downloadFile(serverUrl, "token", transfer, File(temp.root, "big.bin"), onProgress = { done, _ -> progress += done })
        assertArrayEquals(content, saved.readBytes())
        assertEquals(listOf(300L, 600L, 900L, 1000L), progress)
        // One probe, then reads from offsets 0, 300, 600, 900.
        assertEquals(listOf("0", "0", "300", "600", "900"), device.fileReads.map { it.getValue("offset") })
        assertTrue(device.fileReads.all { it["root"] == "ws" })
        assertTrue(serverRequests.isEmpty())
        assertFalse(temp.root.listFiles()!!.any { it.name.endsWith(".part") })
    }

    @Test
    fun attachmentsAreSealedAndOnlyTheDeviceGetsTheKey() {
        val plaintext = ByteArray(150_000) { (it % 251).toByte() }
        val sessions = SessionsApi(apiClient)
        val uploaded = sessions.uploadSessionAttachments(serverUrl, "token", "sess_paired", listOf(UploadFilePart("notes.bin", "text/x-notes", plaintext)))
        // Callers see the plaintext size and digest, as in normal mode.
        assertEquals(plaintext.size.toLong(), uploaded.single().size)
        assertEquals(E2eeFormats.hex(NoiseCrypto.sha256(plaintext)), uploaded.single().sha256)

        assertEquals("notes.bin", uploaded.single().name)
        assertEquals("text/x-notes", uploaded.single().mediaType)
        val (request, body) = serverRequests.single()
        assertEquals(SealedUpload.VALUE, request.getHeader(SealedUpload.HEADER))
        // The Server sees neither the real name nor the type.
        val head = String(body, Charsets.ISO_8859_1).substringBefore("\r\n\r\n")
        assertTrue(head.contains("filename=\"attachment.bin\""))
        assertTrue(head.contains("Content-Type: application/octet-stream"))
        assertFalse(head.contains("notes.bin"))
        val ciphertext = multipartFile(request, body)
        assertEquals(plaintext.size + 3 * 16, ciphertext.size)
        assertFalse(String(body, Charsets.ISO_8859_1).contains(String(plaintext.copyOfRange(0, 64), Charsets.ISO_8859_1)))

        sessions.sendSessionMessage(serverUrl, "token", "sess_paired", content = "see file", clientMessageId = "m_att", attachments = listOf(RemoteAttachmentRef("file_1")))
        val sent = device.requests.last().getJSONObject("body")
        assertEquals("file_1", sent.getJSONArray("attachments").getJSONObject(0).getString("fileId"))
        val key = sent.getJSONArray("sealedAttachmentKeys").getJSONObject(0)
        assertEquals("file_1", key.getString("fileId"))
        assertEquals("notes.bin", key.getString("name"))
        assertEquals("text/x-notes", key.getString("mimeType"))
        assertArrayEquals(plaintext, device.openSealedAttachment(ciphertext, key))
        // The key never reached the Server.
        assertEquals(1, serverRequests.size)
        assertEquals(listOf("m_att"), registered)
    }

    @Test
    fun terminalStreamsThroughTheChannel() {
        val opened = CountDownLatch(1)
        val messages = CopyOnWriteArrayList<String>()
        val received = CountDownLatch(1)
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = opened.countDown()
            override fun onMessage(webSocket: WebSocket, text: String) {
                messages += text
                received.countDown()
            }
        }
        val url = "${serverUrl.replace("http", "ws")}/api/v2/connectors/dev_paired/terminals-v2/t1/stream?fromSeq=3&token=x"
        val socket = router.terminalSocket(url, listener)
        assertNotNull(socket)
        (socket as DeferredStartSocket).start()
        assertTrue(opened.await(5, TimeUnit.SECONDS))
        assertTrue(received.await(5, TimeUnit.SECONDS))
        val output = JSONObject(messages.single())
        assertEquals("output", output.getString("type"))
        assertEquals("hello", String(java.util.Base64.getDecoder().decode(output.getString("data"))))
        val subscription = device.subscriptions.single()
        assertEquals("terminal", subscription.getString("stream"))
        assertEquals("t1", subscription.getString("terminalId"))
        assertEquals("seq:3", subscription.getString("afterCursor"))

        // Input and resize become requests to the normal-mode paths, in order.
        assertTrue(socket.send(JSONObject().put("type", "input").put("data", "bHM=").toString()))
        assertTrue(socket.send(JSONObject().put("type", "resize").put("cols", 100).put("rows", 30).toString()))
        val deadline = System.currentTimeMillis() + 5_000
        while (device.requests.size < 2 && System.currentTimeMillis() < deadline) Thread.sleep(10)
        val paths = device.requests.map { it.getString("path") }
        assertEquals(listOf("/api/v2/connectors/dev_paired/terminals-v2/t1/write", "/api/v2/connectors/dev_paired/terminals-v2/t1/resize"), paths)
        assertEquals("bHM=", device.requests[0].getJSONObject("body").getString("dataBase64"))
        assertEquals(100, device.requests[1].getJSONObject("body").getInt("cols"))
        socket.close(1000, "done")
        assertFalse(socket.send("{}"))
        assertTrue(serverRequests.isEmpty())

        // A device without encryption keeps the normal WebSocket.
        assertNull(router.terminalSocket(url.replace("dev_paired", "dev_plain"), listener))
    }

    @Test
    fun newSessionsAreCreatedByTheDeviceThroughTheChannel() {
        val body = JSONObject().put("connectorId", "dev_paired").put("projectId", "p1").put("runtime", "codex")
            .put("title", "secret title").put("content", "top secret task").put("goalIntent", true)
            .put("clientMessageId", "m_first")
        val created = apiClient.postJson(serverUrl, "/sessions/create-and-start", body, "token")
        assertEquals("sess_created", created.getJSONObject("session").getString("id"))
        // Nothing reaches the Server: the title counts as content too.
        assertTrue(serverRequests.isEmpty())
        val sent = device.requests.last()
        assertEquals("POST", sent.getString("method"))
        assertEquals("/api/v2/sessions/create-and-start", sent.getString("path"))
        // Same body as in normal mode, /goal included.
        assertTrue(com.agentsanywhere.app.api.e2ee.jsonSimilar(body, sent.getJSONObject("body")))
        // The first message is registered as a command, like any other message.
        assertEquals(listOf("m_first"), registered)
        assertEquals("dev_paired", SessionDeviceDirectory.deviceFor("sess_created"))

        // Attachments need an existing session to be uploaded to: refused, nothing sent.
        val requestsBefore = device.requests.size
        try {
            apiClient.postJson(
                serverUrl, "/sessions/create-and-start",
                JSONObject(body.toString()).put("clientMessageId", "m_att").put("attachments", JSONArray().put(JSONObject().put("fileId", "f"))),
                "token",
            )
            fail("expected a refusal")
        } catch (error: ApiException) {
            assertEquals(E2eeClientErrorCodes.CREATE_UNSUPPORTED, error.errorCode)
        }
        assertTrue(serverRequests.isEmpty())
        assertEquals(requestsBefore, device.requests.size)

        // A device without encryption keeps the normal Server request.
        apiClient.postJson(serverUrl, "/sessions/create-and-start", JSONObject(body.toString()).put("connectorId", "dev_plain"), "token")
        assertEquals("/api/v2/sessions/create-and-start", serverRequests.single().first.path)
    }

    @Test
    fun renamingAnEncryptedSessionIsRefusedLocally() {
        val sessions = SessionsApi(apiClient)
        try {
            sessions.patchSession(serverUrl, "token", "sess_paired", title = "secret title")
            fail("expected a refusal")
        } catch (error: ApiException) {
            assertEquals(E2eeClientErrorCodes.RENAME_UNSUPPORTED, error.errorCode)
        }
        // The title never left the phone, not even through the channel.
        assertTrue(serverRequests.isEmpty())
        assertTrue(device.requests.none { it.getString("path").endsWith("/meta") })

        // Pinning carries no content: it still goes to the Server.
        runCatching { sessions.patchSession(serverUrl, "token", "sess_paired", pinned = true) }
        val (pin, pinBody) = serverRequests.single()
        assertEquals("/api/v2/sessions/sess_paired/meta", pin.path)
        assertFalse(JSONObject(String(pinBody)).has("title"))

        // A session on a device without encryption is renamed as usual.
        SessionDeviceDirectory.remember("plain_1", "dev_plain")
        runCatching { sessions.patchSession(serverUrl, "token", "plain_1", title = "visible") }
        assertEquals("/api/v2/sessions/plain_1/meta", serverRequests.last().first.path)
    }

    @Test
    fun aRepeatedCreateLeavesTheOutcomeToBeReconciled() {
        val body = JSONObject().put("connectorId", "dev_paired").put("content", "again").put("clientMessageId", "m_dup")
        // The Server says this command was already sent: the device's answer is not known here.
        duplicateCommands = true
        try {
            apiClient.postJson(serverUrl, "/sessions/create-and-start", body, "token")
            fail("expected an unknown outcome")
        } catch (error: ApiException) {
            // No status code and an IO cause: the caller looks for the session instead of reporting a failure.
            assertNull(error.statusCode)
            assertTrue(error.cause is java.io.IOException)
        }
        assertTrue(serverRequests.isEmpty())
    }

    @Test
    fun attachmentImagesAreFetchedThroughTheChannelIntoAPrivateFile() {
        val image = ByteArray(2048) { it.toByte() }
        device.attachments["file_img"] = image
        val transfer = SessionAttachmentTransfer(SessionsApi(apiClient))
        val request = transfer.imageRequestLoading(
            serverUrl, "token", "sess_paired",
            TimelineAttachment("file_img", "a.png", "image/png", image.size.toLong()),
            temp.root,
        )
        assertTrue(request.url.startsWith("file:"))
        assertEquals("", request.authorizationToken)
        assertArrayEquals(image, File(java.net.URI(request.url)).readBytes())
        assertTrue(serverRequests.isEmpty())
    }

    @Test
    fun logoutForgetsSessionsKeysAndChannels() {
        SessionsApi(apiClient).uploadSessionAttachments(serverUrl, "token", "sess_paired", listOf(UploadFilePart("a", "text/plain", ByteArray(5))))
        assertNotNull(router.sealedKeys.keyFor("file_1", "dev_paired"))
        val channel = runBlocking { e2ee.channel("dev_paired") }
        router.resetForLogout()
        assertNull(SessionDeviceDirectory.deviceFor("sess_paired"))
        assertNull(router.sealedKeys.keyFor("file_1", "dev_paired"))
        assertNotNull(channel.closed)
    }
}
