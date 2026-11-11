package com.agentsanywhere.app.feature.files

import java.io.File
import java.security.MessageDigest

/** Cache directory shared with other apps through the `file-previews/` FileProvider path. */
const val FILE_PREVIEW_CACHE_DIRECTORY = "file-previews"

private const val MAX_FILE_NAME_BYTES = 200
private const val MAX_CACHED_PREVIEWS = 40
private const val MAX_CACHED_PREVIEW_BYTES = 768L * 1024 * 1024
private const val PREVIEW_CACHE_MAX_AGE_MILLIS = 3L * 24 * 60 * 60 * 1000

/**
 * Local name for a downloaded file. Keeps Chinese characters, spaces and the
 * extension so share targets and the Downloads collection show the original
 * name; only path separators and control characters are replaced, and names
 * longer than the filesystem allows are shortened before the extension.
 */
fun localFileName(name: String, fallback: String = "download"): String {
    val base = name.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = buildString {
        base.forEach { char ->
            append(if (char.isISOControl() || char == '/' || char == '\\') '_' else char)
        }
    }.trim()
    val safe = if (cleaned.isBlank() || cleaned.all { it == '.' }) fallback else cleaned
    return shortenFileName(safe, MAX_FILE_NAME_BYTES)
}

private fun shortenFileName(name: String, maxBytes: Int): String {
    if (name.toByteArray(Charsets.UTF_8).size <= maxBytes) return name
    val dot = name.lastIndexOf('.')
    val suffix = if (dot > 0 && name.length - dot <= 16) name.substring(dot) else ""
    var stem = name.substring(0, name.length - suffix.length)
    while (stem.isNotEmpty() && (stem + suffix).toByteArray(Charsets.UTF_8).size > maxBytes) {
        val drop = if (stem.length >= 2 && stem.last().isLowSurrogate()) 2 else 1
        stem = stem.dropLast(drop)
    }
    return stem.trimEnd() + suffix
}

/**
 * Directory that holds one downloaded version of a remote file. The content
 * hash is part of the key, so a regenerated report downloads again while
 * reopening an unchanged one reuses the local copy.
 */
fun filePreviewCacheDirectory(
    cacheDir: File,
    connectorId: String,
    path: String,
    sha256: String,
): File {
    val digest = MessageDigest.getInstance("SHA-256")
        .digest("$connectorId\u0000${normalizeRemotePath(path)}\u0000${sha256.lowercase()}".toByteArray())
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return File(File(cacheDir, FILE_PREVIEW_CACHE_DIRECTORY), digest.take(32))
}

/**
 * Drops previews older than three days, then the least recently used ones
 * beyond the count and size budget. [keep] is never removed.
 */
fun pruneFilePreviewCache(cacheDir: File, keep: File? = null, now: Long = System.currentTimeMillis()) {
    val root = File(cacheDir, FILE_PREVIEW_CACHE_DIRECTORY)
    val entries = root.listFiles()?.filter { it.isDirectory && it != keep } ?: return
    val stale = entries.filter { now - it.lastModified() > PREVIEW_CACHE_MAX_AGE_MILLIS }
    stale.forEach { it.deleteRecursively() }
    val remaining = (entries - stale.toSet()).sortedByDescending { it.lastModified() }
    var totalBytes = keep?.walkTopDown()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
    remaining.forEachIndexed { index, entry ->
        val size = entry.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        totalBytes += size
        if (index >= MAX_CACHED_PREVIEWS - 1 || totalBytes > MAX_CACHED_PREVIEW_BYTES) {
            entry.deleteRecursively()
        }
    }
}
