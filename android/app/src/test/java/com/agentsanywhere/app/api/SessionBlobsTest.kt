package com.agentsanywhere.app.api

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

/** Protocol 1.2 `TimelineItem.blobRefs` decoding and the chunked blob read. */
class SessionBlobsTest {
    private val api = SessionsApi(ApiClient(contentGate = { null }))

    private fun item(extra: JSONObject.() -> Unit = {}) = JSONObject()
        .put("id", "item_1")
        .put("sessionId", "sess_1")
        .put("type", "tool")
        .put("content", JSONObject().put("kind", "command").put("output", "head…tail"))
        .apply(extra)

    @Test
    fun blobRefsDecodeAndMalformedEntriesAreSkipped() {
        val parsed = api.parseTimelineItem(
            item {
                put(
                    "blobRefs",
                    JSONArray()
                        .put(JSONObject().put("path", "/output").put("blobId", "blob_1").put("bytes", 81920).put("mediaType", "text/plain; charset=utf-8"))
                        .put(JSONObject().put("path", "/content/0/data").put("blobId", "blob_2").put("bytes", 120).put("mediaType", JSONObject.NULL))
                        .put(JSONObject().put("blobId", "blob_without_path"))
                        .put(JSONObject().put("path", "/x"))
                        .put("not an object"),
                )
            },
        )
        assertEquals(
            listOf(
                RemoteBlobRef("/output", "blob_1", 81920, "text/plain; charset=utf-8"),
                RemoteBlobRef("/content/0/data", "blob_2", 120, null),
            ),
            parsed.blobRefs,
        )
    }

    @Test
    fun absentOrNullBlobRefsKeepDecoding() {
        assertEquals(emptyList<RemoteBlobRef>(), api.parseTimelineItem(item()).blobRefs)
        assertEquals(emptyList<RemoteBlobRef>(), api.parseTimelineItem(item { put("blobRefs", JSONObject.NULL) }).blobRefs)
        assertEquals("head…tail", api.parseTimelineItem(item { put("blobRefs", JSONObject.NULL) }).content.getString("output"))
    }

    @Test
    fun blobRefsSurviveTheDiskDocument() {
        val parsed = api.parseTimelineItem(
            item { put("blobRefs", JSONArray().put(JSONObject().put("path", "/output").put("blobId", "blob_1").put("bytes", 9).put("mediaType", JSONObject.NULL))) },
        )
        val json = parsed.toProtocolJson()
        assertTrue(json.getJSONArray("blobRefs").getJSONObject(0).isNull("mediaType"))
        assertEquals(parsed.blobRefs, api.parseTimelineItem(json).blobRefs)
        // No blobRefs: the stored document has none either.
        assertTrue(!api.parseTimelineItem(item()).toProtocolJson().has("blobRefs"))
    }

    private fun chunk(data: ByteArray, offset: Long, size: Long, eof: Boolean) = JSONObject()
        .put("blobRef", "blob_1")
        .put("name", "output.txt")
        .put("mediaType", "text/plain; charset=utf-8")
        .put("encoding", "base64")
        .put("data", Base64.getEncoder().encodeToString(data))
        .put("offset", offset)
        .put("size", size)
        .put("eof", eof)

    @Test
    fun readsChunksUntilEof() {
        val bytes = ByteArray(10) { it.toByte() }
        val offsets = mutableListOf<Long>()
        val blob = readBlobChunks("blob_1", 100) { offset ->
            offsets += offset
            val end = minOf(10, offset.toInt() + 4)
            chunk(bytes.copyOfRange(offset.toInt(), end), offset, 10, end == 10)
        }
        assertArrayEquals(bytes, blob.bytes)
        assertEquals(listOf(0L, 4L, 8L), offsets)
        assertEquals(10L, blob.size)
        assertEquals("output.txt", blob.name)
        assertEquals("text/plain; charset=utf-8", blob.mediaType)
    }

    @Test
    fun anEmptyBlobIsOneEofChunk() {
        val blob = readBlobChunks("blob_1", 100) { chunk(ByteArray(0), 0, 0, true) }
        assertEquals(0, blob.bytes.size)
    }

    private fun assertFails(code: String, fetch: (Long) -> JSONObject, maxBytes: Long = 100) {
        try {
            readBlobChunks("blob_1", maxBytes, fetch)
            fail("expected $code")
        } catch (error: ApiException) {
            assertEquals(code, error.errorCode)
        }
    }

    @Test
    fun rejectsChunksOutOfOrder() = assertFails(SessionBlobErrors.INCOMPLETE, { offset ->
        if (offset == 0L) chunk(ByteArray(4), 0, 10, false) else chunk(ByteArray(4), 0, 10, false)
    })

    @Test
    fun rejectsEofBeforeTheAnnouncedSize() = assertFails(SessionBlobErrors.INCOMPLETE, { chunk(ByteArray(4), 0, 10, true) })

    @Test
    fun rejectsAnEmptyChunkBeforeEof() = assertFails(SessionBlobErrors.INCOMPLETE, { offset ->
        if (offset == 0L) chunk(ByteArray(4), 0, 10, false) else chunk(ByteArray(0), offset, 10, false)
    })

    @Test
    fun rejectsASizeThatChangesBetweenChunks() = assertFails(SessionBlobErrors.INCOMPLETE, { offset ->
        if (offset == 0L) chunk(ByteArray(4), 0, 10, false) else chunk(ByteArray(4), offset, 12, false)
    })

    @Test
    fun rejectsMoreBytesThanTheBlobHolds() = assertFails(SessionBlobErrors.INCOMPLETE, { chunk(ByteArray(12), 0, 10, true) })

    @Test
    fun rejectsABlobLargerThanTheCap() = assertFails(SessionBlobErrors.TOO_LARGE, { chunk(ByteArray(4), 0, 1000, false) }, maxBytes = 100)

    @Test
    fun rejectsUnreadableChunks() {
        assertFails(SessionBlobErrors.UNREADABLE, { chunk(ByteArray(4), 0, 4, true).put("data", "***") })
        assertFails(SessionBlobErrors.UNREADABLE, { chunk(ByteArray(4), 0, 4, true).put("encoding", "hex") })
        assertFails(SessionBlobErrors.UNREADABLE, { chunk(ByteArray(4), 0, 4, true).apply { remove("eof") } })
        assertFails(SessionBlobErrors.UNREADABLE, { chunk(ByteArray(4), 0, 4, true).apply { remove("size") } })
    }

    @Test
    fun readSessionBlobAsksForEachOffsetOnTheSessionRoute() {
        val server = MockWebServer()
        val bytes = ByteArray(6) { (it + 1).toByte() }
        server.enqueue(json(chunk(bytes.copyOfRange(0, 4), 0, 6, false)))
        server.enqueue(json(chunk(bytes.copyOfRange(4, 6), 4, 6, true)))
        server.start()
        try {
            val url = "http://127.0.0.1:${server.port}"
            val blob = api.readSessionBlob(url, "token", "sess/1", "blob_1")
            assertArrayEquals(bytes, blob.bytes)
            val first = server.takeRequest()
            val second = server.takeRequest()
            assertEquals("/api/v2/sessions/sess%2F1/blobs/blob_1", first.requestUrl!!.encodedPath)
            assertEquals("0", first.requestUrl!!.queryParameter("offset"))
            assertEquals("4", second.requestUrl!!.queryParameter("offset"))
            assertEquals(SessionBlobLimits.CHUNK_BYTES.toString(), first.requestUrl!!.queryParameter("length"))
            assertEquals("Bearer token", first.getHeader("Authorization"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun aMissingBlobKeepsTheDeviceErrorCode() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                .setBody(JSONObject().put("detail", JSONObject().put("code", "blob_not_found").put("message", "gone")).toString()),
        )
        server.enqueue(
            MockResponse().setResponseCode(409).setHeader("Content-Type", "application/json")
                .setBody(JSONObject().put("detail", JSONObject().put("code", "connector_offline").put("message", "offline")).toString()),
        )
        server.start()
        try {
            val url = "http://127.0.0.1:${server.port}"
            listOf(404 to SessionBlobErrors.NOT_FOUND, 409 to SessionBlobErrors.DEVICE_OFFLINE).forEach { (status, code) ->
                try {
                    api.readSessionBlob(url, "token", "sess_1", "blob_x")
                    fail("expected $code")
                } catch (error: ApiException) {
                    assertEquals(status, error.statusCode)
                    assertEquals(code, error.errorCode)
                }
            }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun aChunkWithoutNameOrTypeFallsBackToTheRef() {
        val parsed = JSONObject().put("data", "").put("offset", 0).put("size", 0).put("eof", true).toBlobChunk("blob_9")
        assertEquals("blob_9", parsed.blobRef)
        assertEquals("blob_9", parsed.name)
        assertEquals("application/octet-stream", parsed.mediaType)
    }

    private fun json(body: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())
}
