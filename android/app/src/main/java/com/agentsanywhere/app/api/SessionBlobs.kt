package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Base64

/** Limits for reading device blobs through `GET /sessions/{id}/blobs/{ref}`. */
object SessionBlobLimits {
    /** Largest `length` the blob route accepts per request. */
    const val CHUNK_BYTES = 4 * 1024 * 1024

    /** Default cap for one blob held in memory. */
    const val DEFAULT_MAX_BYTES = 64L * 1024L * 1024L
}

/** Error codes of blob reads: the device's own codes plus the ones raised by this client. */
object SessionBlobErrors {
    /** The device no longer has the blob (or it is not part of this session). */
    const val NOT_FOUND = "blob_not_found"

    /** The device is offline (plain mode, answered by the Server). */
    const val DEVICE_OFFLINE = "connector_offline"

    /** The blob is larger than the caller is willing to hold in memory. */
    const val TOO_LARGE = "blob_too_large"

    /** The chunks did not add up to the announced size, or arrived out of order. */
    const val INCOMPLETE = "blob_incomplete"

    /** A chunk could not be decoded. */
    const val UNREADABLE = "blob_unreadable"
}

/** Parses `TimelineItem.blobRefs`; malformed entries are skipped, absent or null means none. */
internal fun JSONArray?.toBlobRefs(): List<RemoteBlobRef> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { index ->
        val ref = optJSONObject(index) ?: return@mapNotNull null
        val path = ref.optNullableString("path") ?: return@mapNotNull null
        val blobId = ref.optNullableString("blobId") ?: return@mapNotNull null
        RemoteBlobRef(
            path = path,
            blobId = blobId,
            bytes = ref.optLong("bytes", 0L).coerceAtLeast(0L),
            mediaType = ref.optNullableString("mediaType"),
        )
    }
}

internal fun List<RemoteBlobRef>.toBlobRefsJson(): JSONArray = JSONArray().also { array ->
    forEach { ref ->
        array.put(
            JSONObject()
                .put("path", ref.path)
                .put("blobId", ref.blobId)
                .put("bytes", ref.bytes)
                .put("mediaType", ref.mediaType ?: JSONObject.NULL),
        )
    }
}

/** Parses one blob chunk; throws [ApiException] with [SessionBlobErrors.UNREADABLE] when it is malformed. */
internal fun JSONObject.toBlobChunk(fallbackRef: String): RemoteBlobChunk {
    fun unreadable(cause: Throwable? = null) =
        ApiException("The device returned an unreadable blob chunk.", 502, cause, errorCode = SessionBlobErrors.UNREADABLE)
    if (optString("encoding", "base64") != "base64") throw unreadable()
    val data = try {
        Base64.getDecoder().decode(optString("data"))
    } catch (error: IllegalArgumentException) {
        throw unreadable(error)
    }
    val offset = optLong("offset", -1L)
    val size = optLong("size", -1L)
    val eof = opt("eof") as? Boolean
    if (offset < 0 || size < 0 || eof == null || data.size > SessionBlobLimits.CHUNK_BYTES) throw unreadable()
    return RemoteBlobChunk(
        blobRef = optNullableString("blobRef") ?: fallbackRef,
        name = optNullableString("name") ?: fallbackRef,
        mediaType = optNullableString("mediaType") ?: "application/octet-stream",
        data = data,
        offset = offset,
        size = size,
        eof = eof,
    )
}

/**
 * Reads a blob from offset 0 until `eof`: each chunk must start where the previous one ended,
 * every chunk must announce the same total size, the total must be reached exactly at `eof`,
 * and an empty chunk before `eof` stops the read.
 */
internal fun readBlobChunks(
    blobRef: String,
    maxBytes: Long,
    fetch: (offset: Long) -> JSONObject,
): RemoteSessionBlob {
    fun incomplete(message: String) = ApiException(message, 502, errorCode = SessionBlobErrors.INCOMPLETE)
    val buffer = ByteArrayOutputStream()
    var offset = 0L
    var first: RemoteBlobChunk? = null
    while (true) {
        val chunk = fetch(offset).toBlobChunk(blobRef)
        val head = first ?: chunk.also { first = it }
        if (chunk.size > maxBytes) {
            throw ApiException("The blob is too large to load here.", 413, errorCode = SessionBlobErrors.TOO_LARGE)
        }
        if (chunk.offset != offset) throw incomplete("The device returned a blob chunk out of order.")
        if (chunk.size != head.size) throw incomplete("The blob changed while it was being read.")
        if (offset + chunk.data.size > chunk.size) throw incomplete("The device returned more bytes than the blob holds.")
        buffer.write(chunk.data)
        offset += chunk.data.size
        if (chunk.eof) {
            if (offset != chunk.size) throw incomplete("The blob download was incomplete.")
            return RemoteSessionBlob(
                blobRef = head.blobRef,
                name = head.name,
                mediaType = head.mediaType,
                size = chunk.size,
                bytes = buffer.toByteArray(),
            )
        }
        if (chunk.data.isEmpty()) throw incomplete("The device stopped sending the blob before its end.")
    }
}
