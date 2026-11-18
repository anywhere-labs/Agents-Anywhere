package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteBlobRef
import com.agentsanywhere.app.api.RemoteSessionBlob
import com.agentsanywhere.app.api.SessionBlobErrors
import com.agentsanywhere.app.api.SessionsApi
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Blob refs on timeline rows, JSON pointer resolution, the blob loader, and user-message attachments. */
class SessionBlobRefsTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val api = SessionsApi(ApiClient(contentGate = { null }))

    @Test
    fun jsonPointerFollowsObjectsArraysAndEscapes() {
        val doc = JSONObject()
            .put("output", "preview")
            .put("a/b", JSONObject().put("m~n", 3))
            .put("content", JSONArray().put(JSONObject().put("type", "image")).put(JSONObject().put("text", "x")))
            .put("nothing", JSONObject.NULL)
        assertEquals("preview", resolveJsonPointer(doc, "/output"))
        assertEquals(3, resolveJsonPointer(doc, "/a~1b/m~0n"))
        assertEquals("x", resolveJsonPointer(doc, "/content/1/text"))
        assertSame(doc, resolveJsonPointer(doc, ""))
        assertNull(resolveJsonPointer(doc, "/content/2"))
        assertNull(resolveJsonPointer(doc, "/content/01"))
        assertNull(resolveJsonPointer(doc, "/content/-"))
        assertNull(resolveJsonPointer(doc, "/missing"))
        assertNull(resolveJsonPointer(doc, "/nothing"))
        assertNull(resolveJsonPointer(doc, "/output/deeper"))
        assertNull(resolveJsonPointer(doc, "output"))
        assertNull(jsonPointerTokens("/bad~2escape"))
        assertEquals(listOf("", "x"), jsonPointerTokens("//x"))
    }

    @Test
    fun mediaTypeKindAndLabelAreDerivedFromTheRefAndTheContent() {
        val content = JSONObject()
            .put("output", "head…（中间省略 12 KB，完整内容 80 KB，可展开查看）…tail")
            .put("content", JSONArray().put(JSONObject().put("type", "image").put("mimeType", "image/png").put("omitted", "图片，约 120 KB，已存到本机")))
            .put("rawOutput", JSONObject().put("stdout", "[image/jpeg，120 KB，已存到本机，可展开查看]").put("audio", "[audio/wav，2 MB，已存到本机，可展开查看]"))
        val text = RemoteBlobRef("/output", "blob_t", 81920, "text/plain; charset=utf-8").toTimelineBlobRef(content)
        assertEquals(TimelineBlobKind.Text, text.kind)
        assertEquals("output", text.label)
        assertEquals("output.txt", text.fileName)

        val removedData = RemoteBlobRef("/content/0/data", "blob_i", 122880, null).toTimelineBlobRef(content)
        assertEquals("image/png", removedData.mediaType)
        assertEquals(TimelineBlobKind.Image, removedData.kind)
        assertEquals("content", removedData.label)

        val placeholder = RemoteBlobRef("/rawOutput/stdout", "blob_p", 122880, null).toTimelineBlobRef(content)
        assertEquals("image/jpeg", placeholder.mediaType)
        assertEquals(TimelineBlobKind.Image, placeholder.kind)
        assertEquals("stdout", placeholder.label)

        val audio = RemoteBlobRef("/rawOutput/audio", "blob_a", 2_000_000, null).toTimelineBlobRef(content)
        assertEquals(TimelineBlobKind.Other, audio.kind)
        assertEquals("audio.wav", audio.fileName)

        val unknown = RemoteBlobRef("/gone", "blob_u", 5, null).toTimelineBlobRef(content)
        assertEquals("application/octet-stream", unknown.mediaType)
        assertEquals(TimelineBlobKind.Other, unknown.kind)

        assertEquals(TimelineBlobKind.Text, blobKind("application/json"))
        assertEquals(TimelineBlobKind.Other, blobKind("application/pdf"))
    }

    @Test
    fun largeTextAndImagesAreOfferedAsFiles() {
        val content = JSONObject()
        val bigText = RemoteBlobRef("/output", "b1", MAX_INLINE_TEXT_BLOB_BYTES + 1, "text/plain").toTimelineBlobRef(content)
        val bigImage = RemoteBlobRef("/image", "b2", MAX_INLINE_IMAGE_BLOB_BYTES + 1, "image/png").toTimelineBlobRef(content)
        assertEquals(TimelineBlobKind.Other, bigText.displayKind())
        assertEquals(TimelineBlobKind.Other, bigImage.displayKind())
        assertEquals(TimelineBlobKind.Text, bigText.copy(bytes = 10).displayKind())
    }

    private fun projected(vararg items: JSONObject): List<TimelineMessage> =
        mergeRemoteTimelineItems(emptyList(), emptyList(), items.map(api::parseTimelineItem), replace = true).messages

    @Test
    fun blobRefsReachTheFirstRowOfTheirItem() {
        val tool = JSONObject()
            .put("id", "tool_1").put("sessionId", "s").put("type", "tool").put("orderSeq", 0)
            .put("content", JSONObject().put("kind", "command").put("command", "ls").put("output", "head…tail"))
            .put("blobRefs", JSONArray().put(JSONObject().put("path", "/output").put("blobId", "blob_1").put("bytes", 9000).put("mediaType", "text/plain; charset=utf-8")))
        val message = projected(tool).single()
        assertEquals(TimelineMessageKind.Command, message.kind)
        assertEquals(listOf("blob_1"), message.blobRefs.map { it.blobId })
        assertEquals(TimelineBlobKind.Text, message.blobRefs.single().kind)

        val fileChange = JSONObject()
            .put("id", "fc_1").put("sessionId", "s").put("type", "tool").put("orderSeq", 1)
            .put(
                "content",
                JSONObject().put("kind", "file_change").put(
                    "changes",
                    JSONArray()
                        .put(JSONObject().put("path", "a.txt").put("kind", "update").put("diff", "-a\n+b"))
                        .put(JSONObject().put("path", "b.txt").put("kind", "update").put("diff", "-c\n+d")),
                ),
            )
            .put("blobRefs", JSONArray().put(JSONObject().put("path", "/changes/0/diff").put("blobId", "blob_2").put("bytes", 9000).put("mediaType", "text/plain")))
        val rows = projected(fileChange)
        assertEquals(1, rows.sumOf { it.blobRefs.size })
        assertEquals("blob_2", rows.first().blobRefs.single().blobId)
    }

    @Test
    fun userMessageAttachmentsShowForEveryRuntime() {
        listOf("codex", "claude-code", "acp", "pi").forEach { runtime ->
            val user = JSONObject()
                .put("id", "u_$runtime").put("sessionId", "s").put("type", "message").put("role", "user").put("orderSeq", 0)
                .put("source", JSONObject().put("runtime", runtime))
                .put(
                    "content",
                    JSONObject().put("text", "look at these").put(
                        "attachments",
                        JSONArray()
                            .put(JSONObject().put("fileId", "file_img").put("name", "shot.png").put("mediaType", "image/png").put("size", 2048).put("sha256", "a".repeat(64)))
                            .put(JSONObject().put("fileId", "file_doc").put("name", "notes.pdf").put("mediaType", "application/pdf"))
                            .put(JSONObject().put("name", "no id")),
                    ),
                )
            val message = projected(user).single()
            assertEquals(MessageAuthor.User, message.author)
            assertEquals(listOf("file_img", "file_doc"), message.attachments.map { it.fileId })
            assertTrue(message.attachments[0].isImage)
            assertEquals(2048L, message.attachments[0].size)
            assertEquals(false, message.attachments[1].isImage)
            assertEquals(0L, message.attachments[1].size)
        }
    }

    @Test
    fun anAttachmentOnlyMessageIsStillShown() {
        val user = JSONObject()
            .put("id", "u_1").put("sessionId", "s").put("type", "message").put("role", "user").put("orderSeq", 0)
            .put("source", JSONObject().put("runtime", "codex"))
            .put("content", JSONObject().put("attachments", JSONArray().put(JSONObject().put("fileId", "f1").put("name", "a.png").put("mediaType", "image/png"))))
        val message = projected(user).single()
        assertEquals(TimelineMessageKind.Text, message.kind)
        assertEquals(listOf("f1"), message.attachments.map { it.fileId })
    }

    @Test
    fun theLoaderDecodesTextCachesItAndRefusesOversizedBlobsWithoutAsking() {
        var reads = 0
        val loader = SessionBlobLoader(read = { _, blobId, maxBytes ->
            reads += 1
            assertEquals(MAX_INLINE_TEXT_BLOB_BYTES, maxBytes)
            val bytes = "完整内容 full".toByteArray()
            RemoteSessionBlob(blobId, "output", "text/plain", bytes.size.toLong(), bytes)
        })
        val ref = TimelineBlobRef("/output", "blob_t", 15, "text/plain", TimelineBlobKind.Text, "output")
        val loaded = loader.load("s", ref, temp.root)
        assertEquals(LoadedBlob.Text("完整内容 full"), loaded)
        assertEquals(loaded, loader.cached("s", "blob_t"))
        assertEquals(loaded, loader.load("s", ref, temp.root))
        assertEquals(1, reads)
        assertNull(loader.cached("other", "blob_t"))

        try {
            loader.load("s", ref.copy(blobId = "blob_big", kind = TimelineBlobKind.Other, bytes = MAX_FILE_BLOB_BYTES + 1), temp.root)
            fail("expected blob_too_large")
        } catch (error: ApiException) {
            assertEquals(SessionBlobErrors.TOO_LARGE, error.errorCode)
        }
        assertEquals(1, reads)
    }

    @Test
    fun theLoaderStoresImagesInTheAttachmentCache() {
        val bytes = ByteArray(32) { it.toByte() }
        val loader = SessionBlobLoader(read = { blobId, _, _ -> RemoteSessionBlob(blobId, "x", "image/png", 32, bytes) })
        val ref = TimelineBlobRef("/content/0/data", "blob_" + "f".repeat(64), 32, "image/png", TimelineBlobKind.Image, "content")
        val loaded = loader.load("s", ref, temp.root) as LoadedBlob.StoredFile
        assertEquals("session-attachments", loaded.file.parentFile!!.name)
        assertTrue(loaded.file.name.endsWith("content.png"))
        assertEquals(bytes.toList(), loaded.file.readBytes().toList())
        // A deleted cache file is loaded again.
        loaded.file.delete()
        assertNull(loader.cached("s", ref.blobId))
    }

    @Test
    fun theTextCacheDropsOldEntriesPastItsBudget() {
        val loader = SessionBlobLoader(
            read = { _, blobId, _ -> val b = ByteArray(10) { 'a'.code.toByte() }; RemoteSessionBlob(blobId, "o", "text/plain", 10, b) },
            maxCachedTextChars = 25,
        )
        listOf("b1", "b2", "b3").forEach { id ->
            loader.load("s", TimelineBlobRef("/o", id, 10, "text/plain", TimelineBlobKind.Text, "o"), temp.root)
        }
        assertNull(loader.cached("s", "b1"))
        assertTrue(loader.cached("s", "b2") is LoadedBlob.Text)
        assertTrue(loader.cached("s", "b3") is LoadedBlob.Text)
    }
}
