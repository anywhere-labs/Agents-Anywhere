package com.agentsanywhere.app.feature.files

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class FilesControllerPreviewTest {
    private val content = ByteArray(300_000) { (it % 251).toByte() }
    private val server = MockWebServer()
    private val prepares = AtomicInteger()
    private val downloads = Collections.synchronizedList(mutableListOf<String>())
    private val preparedPaths = Collections.synchronizedList(mutableListOf<String>())
    private var reportedSha = sha256(content)
    private lateinit var cacheDir: File
    private lateinit var controller: FilesController

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "POST" && path.startsWith("/api/v2/connectors/dev-1/fs/read") -> {
                        val transferId = "t-${prepares.incrementAndGet()}"
                        preparedPaths += JSONObject(request.body.readUtf8()).getString("path")
                        val result = JSONObject()
                            .put("path", "/ws/out/季度 报告.pdf")
                            .put("name", "季度 报告.pdf")
                            .put("size", content.size)
                            .put("sha256", reportedSha)
                            .put("mediaType", "application/pdf")
                            .put("transferId", transferId)
                            .put("downloadUrl", "/api/v2/connectors/dev-1/fs/transfers/$transferId?token=tok")
                        MockResponse().setBody(JSONObject().put("ok", true).put("result", result).toString())
                    }
                    request.method == "GET" && path.startsWith("/api/v2/connectors/dev-1/fs/transfers/") -> {
                        val transferId = path.substringAfterLast('/').substringBefore('?')
                        if (transferId in downloads) {
                            // The Server streams a prepared transfer only once.
                            MockResponse().setResponseCode(404).setBody("{\"detail\":\"transfer not found\"}")
                        } else {
                            downloads += transferId
                            MockResponse().setBody(Buffer().write(content))
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        cacheDir = Files.createTempDirectory("preview-controller").toFile()
        val store = AuthSessionStore(RuntimeEnvironment.getApplication())
        store.saveAuthSession(server.url("/").toString(), AuthResponse("user", "member", "token", "bearer", "now"))
        controller = FilesController(FilesApi(ApiClient()), store)
    }

    @After
    fun tearDown() {
        server.shutdown()
        cacheDir.deleteRecursively()
    }

    @Test
    fun downloadKeepsTheOriginalNameAndReportsProgress() = runBlocking {
        val target = FilePreviewTarget("dev-1", "/ws", "out/季度 报告.pdf")
        val info = controller.prepareRemoteFile(target).getOrThrow()
        assertEquals("季度 报告.pdf", info.name)
        assertEquals(listOf("out/季度 报告.pdf"), preparedPaths)
        val progress = mutableListOf<Long>()
        val local = controller.downloadRemoteFile(info, cacheDir) { done, _ -> progress += done }.getOrThrow()
        assertEquals("季度 报告.pdf", local.file.name)
        assertTrue(local.file.path.contains("/$FILE_PREVIEW_CACHE_DIRECTORY/"))
        assertArrayEquals(content, local.file.readBytes())
        assertEquals(content.size.toLong(), progress.last())
        assertTrue(progress.size > 1)
        assertEquals(local.file, controller.cachedRemoteFile(info, cacheDir))
    }

    @Test
    fun anUnchangedFileIsReusedWithoutAnotherTransfer() = runBlocking {
        val info = controller.prepareRemoteFile(FilePreviewTarget("dev-1", "/ws", "out/季度 报告.pdf")).getOrThrow()
        val first = controller.downloadRemoteFile(info, cacheDir).getOrThrow()
        val second = controller.downloadRemoteFile(info, cacheDir).getOrThrow()
        assertEquals(first.file, second.file)
        assertEquals(1, prepares.get())
        assertEquals(listOf("t-1"), downloads)
    }

    @Test
    fun aUsedTransferIsPreparedAgain() = runBlocking {
        val info = controller.prepareRemoteFile(FilePreviewTarget("dev-1", "/ws", "out/季度 报告.pdf")).getOrThrow()
        controller.downloadRemoteFile(info, cacheDir).getOrThrow().file.parentFile?.deleteRecursively()
        val again = controller.downloadRemoteFile(info, cacheDir).getOrThrow()
        assertEquals(2, prepares.get())
        assertEquals(listOf("t-1", "t-2"), downloads)
        assertArrayEquals(content, again.file.readBytes())
    }

    @Test
    fun corruptedDownloadsFailTheIntegrityCheck() = runBlocking {
        reportedSha = "0".repeat(64)
        val info = controller.prepareRemoteFile(FilePreviewTarget("dev-1", "/ws", "out/季度 报告.pdf")).getOrThrow()
        val error = controller.downloadRemoteFile(info, cacheDir).exceptionOrNull()
        assertTrue(error is ApiException)
        assertEquals(502, (error as ApiException).statusCode)
        assertEquals(null, controller.cachedRemoteFile(info, cacheDir))
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
