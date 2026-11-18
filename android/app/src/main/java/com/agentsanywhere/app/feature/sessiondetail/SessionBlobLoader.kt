package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteSessionBlob
import com.agentsanywhere.app.api.SessionBlobErrors
import java.io.File

/** A device blob loaded for display. */
sealed interface LoadedBlob {
    /** The full text of a text blob. */
    data class Text(val text: String) : LoadedBlob

    /** An image or other media saved in the app's private cache. */
    data class StoredFile(val file: File, val mediaType: String, val name: String) : LoadedBlob
}

/** How a blob is shown once loaded: as text, as an image, or as a file for another app. */
fun TimelineBlobRef.displayKind(): TimelineBlobKind = when {
    kind == TimelineBlobKind.Text && bytes > MAX_INLINE_TEXT_BLOB_BYTES -> TimelineBlobKind.Other
    kind == TimelineBlobKind.Image && bytes > MAX_INLINE_IMAGE_BLOB_BYTES -> TimelineBlobKind.Other
    else -> kind
}

/**
 * Loads device blobs and remembers the results for this process, so a row that scrolls back into
 * view shows what was already loaded. Text is kept in memory up to [maxCachedTextChars]; files stay
 * in the cache directory.
 */
internal class SessionBlobLoader(
    private val read: (sessionId: String, blobId: String, maxBytes: Long) -> RemoteSessionBlob,
    private val maxCachedTextChars: Long = 8L * 1024L * 1024L,
) {
    private val loaded = object : LinkedHashMap<String, LoadedBlob>(16, 0.75f, true) {}

    fun cached(sessionId: String, blobId: String): LoadedBlob? = synchronized(loaded) {
        loaded[key(sessionId, blobId)]?.takeIf { it !is LoadedBlob.StoredFile || it.file.isFile }
    }

    fun load(sessionId: String, ref: TimelineBlobRef, cacheDir: File): LoadedBlob {
        cached(sessionId, ref.blobId)?.let { return it }
        val kind = ref.displayKind()
        val limit = blobLoadLimit(kind)
        if (ref.bytes > limit) {
            throw ApiException("The blob is too large to load here.", 413, errorCode = SessionBlobErrors.TOO_LARGE)
        }
        val blob = read(sessionId, ref.blobId, limit)
        val result = when (kind) {
            TimelineBlobKind.Text -> LoadedBlob.Text(blob.bytes.toString(Charsets.UTF_8))
            TimelineBlobKind.Image, TimelineBlobKind.Other -> LoadedBlob.StoredFile(
                file = writeBlobFile(cacheDir, ref, blob.bytes),
                mediaType = ref.mediaType,
                name = ref.fileName,
            )
        }
        remember(key(sessionId, ref.blobId), result)
        return result
    }

    fun clear() = synchronized(loaded) { loaded.clear() }

    private fun remember(key: String, value: LoadedBlob) = synchronized(loaded) {
        loaded[key] = value
        var textChars = loaded.values.sumOf { (it as? LoadedBlob.Text)?.text?.length?.toLong() ?: 0L }
        val iterator = loaded.entries.iterator()
        while (textChars > maxCachedTextChars && iterator.hasNext()) {
            val entry = iterator.next()
            val text = entry.value as? LoadedBlob.Text ?: continue
            if (entry.key == key) continue
            textChars -= text.text.length
            iterator.remove()
        }
    }

    private fun key(sessionId: String, blobId: String) = "$sessionId\u0000$blobId"
}

internal fun writeBlobFile(cacheDir: File, ref: TimelineBlobRef, bytes: ByteArray): File {
    val directory = File(cacheDir, "session-attachments").apply { mkdirs() }
    check(directory.isDirectory) { "Could not create the blob cache directory." }
    val target = File(directory, attachmentCacheFileName(ref.blobId, ref.fileName)).canonicalFile
    check(target.parentFile == directory.canonicalFile) { "Blob cache path escaped its directory." }
    target.writeBytes(bytes)
    return target
}
