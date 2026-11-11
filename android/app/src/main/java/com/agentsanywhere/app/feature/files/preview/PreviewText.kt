package com.agentsanywhere.app.feature.files.preview

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/** Text read for a preview, with a flag when the file was longer than the limit. */
data class PreviewTextContent(
    val text: String,
    val truncated: Boolean,
)

/**
 * Reads up to [maxBytes] of a text file. Honors UTF-8/UTF-16 byte order marks,
 * prefers UTF-8 and falls back to GB18030, the encoding Excel and many
 * Chinese Windows tools use for CSV and TXT exports.
 */
fun readPreviewText(file: File, maxBytes: Long): PreviewTextContent {
    val length = file.length()
    val limit = minOf(length, maxBytes).toInt()
    val bytes = ByteArray(limit)
    file.inputStream().use { input ->
        var offset = 0
        while (offset < limit) {
            val read = input.read(bytes, offset, limit - offset)
            if (read < 0) break
            offset += read
        }
    }
    return PreviewTextContent(decodePreviewText(bytes, truncated = length > limit), truncated = length > limit)
}

internal fun decodePreviewText(bytes: ByteArray, truncated: Boolean = false): String {
    if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
        return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
    }
    if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
        return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
    }
    if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
        return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
    }
    // A truncated read can end inside a multi-byte character; ignore that tail.
    val candidate = if (truncated) bytes.copyOf(utf8SafeLength(bytes)) else bytes
    strictDecode(candidate, Charsets.UTF_8)?.let { return it }
    val gb18030 = runCatching { Charset.forName("GB18030") }.getOrNull()
    if (gb18030 != null) strictDecode(bytes, gb18030)?.let { return it }
    return String(bytes, Charsets.UTF_8)
}

private fun strictDecode(bytes: ByteArray, charset: Charset): String? {
    val decoder = charset.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        decoder.decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        null
    }
}

private fun utf8SafeLength(bytes: ByteArray): Int {
    var end = bytes.size
    var back = 0
    while (end > 0 && back < 4) {
        val value = bytes[end - 1].toInt() and 0xFF
        if (value and 0xC0 != 0x80) {
            val expected = when {
                value and 0x80 == 0 -> 1
                value and 0xE0 == 0xC0 -> 2
                value and 0xF0 == 0xE0 -> 3
                value and 0xF8 == 0xF0 -> 4
                else -> 1
            }
            return if (back + 1 >= expected) bytes.size else end - 1
        }
        end -= 1
        back += 1
    }
    return bytes.size
}
