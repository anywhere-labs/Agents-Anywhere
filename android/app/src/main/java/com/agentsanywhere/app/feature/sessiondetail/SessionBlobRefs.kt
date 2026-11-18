package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteBlobRef
import com.agentsanywhere.app.api.RemoteTimelineItem
import org.json.JSONArray
import org.json.JSONObject

/** How a device blob is offered in the timeline. */
enum class TimelineBlobKind {
    /** The item holds a head/tail preview; the blob is the full UTF-8 text. */
    Text,

    /** An image whose bytes were moved to the device. */
    Image,

    /** Any other media (audio, binary): offered as a file. */
    Other,
}

/** A large field of a timeline item that is kept on the device and loaded on request. */
data class TimelineBlobRef(
    val path: String,
    val blobId: String,
    val bytes: Long,
    val mediaType: String,
    val kind: TimelineBlobKind,
    /** A short name derived from [path], e.g. `output` or `stdout`. */
    val label: String,
) {
    /** A file name for saving or opening the blob outside the app. */
    val fileName: String
        get() = label + blobFileExtension(mediaType)
}

/** Largest text blob rendered inside the app. */
const val MAX_INLINE_TEXT_BLOB_BYTES = 4L * 1024L * 1024L

/** Largest image blob decoded inside the app. */
const val MAX_INLINE_IMAGE_BLOB_BYTES = 20L * 1024L * 1024L

/** Largest blob handed to another app as a file. */
const val MAX_FILE_BLOB_BYTES = 64L * 1024L * 1024L

/** The size cap used when loading a blob of [kind]. */
fun blobLoadLimit(kind: TimelineBlobKind): Long = when (kind) {
    TimelineBlobKind.Text -> MAX_INLINE_TEXT_BLOB_BYTES
    TimelineBlobKind.Image -> MAX_INLINE_IMAGE_BLOB_BYTES
    TimelineBlobKind.Other -> MAX_FILE_BLOB_BYTES
}

/**
 * Splits an RFC 6901 JSON pointer into unescaped reference tokens (`~1` → `/`, `~0` → `~`).
 * The empty pointer is the whole document; anything not starting with `/` is invalid (null).
 */
internal fun jsonPointerTokens(pointer: String): List<String>? {
    if (pointer.isEmpty()) return emptyList()
    if (!pointer.startsWith('/')) return null
    return pointer.substring(1).split('/').map { token ->
        if (Regex("~[^01]|~$").containsMatchIn(token)) return null
        token.replace("~1", "/").replace("~0", "~")
    }
}

/** The value [pointer] refers to inside [root], or null when it does not exist. */
internal fun resolveJsonPointer(root: Any?, pointer: String): Any? {
    val tokens = jsonPointerTokens(pointer) ?: return null
    var current: Any? = root
    for (token in tokens) {
        current = when (val node = current) {
            is JSONObject -> if (node.has(token)) node.opt(token) else return null
            is JSONArray -> {
                // RFC 6901: array indices are decimal without leading zeros.
                if (!Regex("0|[1-9][0-9]*").matches(token)) return null
                val index = token.toIntOrNull() ?: return null
                if (index >= node.length()) return null
                node.opt(index)
            }
            else -> return null
        }
    }
    return current.takeUnless { it == JSONObject.NULL }
}

private val MEDIA_KEYS = setOf("data", "blob")
private val PLACEHOLDER_MEDIA_TYPE = Regex("""^\[([A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+)""")

/** The blob refs of this item, resolved against its content to find their media type and a label. */
internal fun RemoteTimelineItem.timelineBlobRefs(): List<TimelineBlobRef> =
    blobRefs.map { it.toTimelineBlobRef(content) }.distinctBy { it.blobId to it.path }

internal fun RemoteBlobRef.toTimelineBlobRef(content: JSONObject): TimelineBlobRef {
    val tokens = jsonPointerTokens(path).orEmpty()
    val mediaType = (mediaType?.takeIf { it.isNotBlank() } ?: inferredMediaType(content, tokens))
        .ifBlank { "application/octet-stream" }
    return TimelineBlobRef(
        path = path,
        blobId = blobId,
        bytes = bytes,
        mediaType = mediaType,
        kind = blobKind(mediaType),
        label = blobLabel(tokens),
    )
}

/** The media type of a removed media block's `data`, or the one named by a `[type/subtype，…]` placeholder. */
private fun RemoteBlobRef.inferredMediaType(content: JSONObject, tokens: List<String>): String {
    if (tokens.lastOrNull() in MEDIA_KEYS) {
        val parentPointer = path.substringBeforeLast('/')
        val block = resolveJsonPointer(content, parentPointer) as? JSONObject
        listOf("mimeType", "mediaType", "mime_type", "media_type").firstNotNullOfOrNull { key ->
            block?.optString(key)?.takeIf { it.contains('/') }
        }?.let { return it }
    }
    val placeholder = resolveJsonPointer(content, path) as? String ?: return ""
    return PLACEHOLDER_MEDIA_TYPE.find(placeholder.trim())?.groupValues?.get(1).orEmpty()
}

internal fun blobKind(mediaType: String): TimelineBlobKind {
    val base = mediaType.substringBefore(';').trim().lowercase()
    return when {
        base.startsWith("text/") -> TimelineBlobKind.Text
        base == "application/json" || base.endsWith("+json") || base.endsWith("+xml") -> TimelineBlobKind.Text
        base.startsWith("image/") -> TimelineBlobKind.Image
        else -> TimelineBlobKind.Other
    }
}

/** The last token that names a field, skipping array indices and generic media keys. */
internal fun blobLabel(tokens: List<String>): String =
    tokens.asReversed()
        .firstOrNull { token -> token.isNotBlank() && token.toIntOrNull() == null && token !in MEDIA_KEYS }
        ?.replace(Regex("[^A-Za-z0-9._-]"), "_")
        ?.take(60)
        ?: "content"

private fun blobFileExtension(mediaType: String): String {
    val base = mediaType.substringBefore(';').trim().lowercase()
    return when (base) {
        "text/plain" -> ".txt"
        "text/markdown" -> ".md"
        "text/html" -> ".html"
        "text/csv" -> ".csv"
        "application/json" -> ".json"
        "image/png" -> ".png"
        "image/jpeg", "image/jpg" -> ".jpg"
        "image/gif" -> ".gif"
        "image/webp" -> ".webp"
        "image/svg+xml" -> ".svg"
        "audio/mpeg" -> ".mp3"
        "audio/wav", "audio/x-wav" -> ".wav"
        "audio/ogg" -> ".ogg"
        "application/pdf" -> ".pdf"
        else -> ""
    }
}
