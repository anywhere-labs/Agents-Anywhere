package com.agentsanywhere.app.feature.files

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.OutputStream

/** Folder inside the public Downloads directory that receives saved files. */
const val DOWNLOADS_SUBFOLDER = "Agents Anywhere"

/** Where a file ended up after saving: the name may gain a ` (1)` suffix when it already existed. */
data class SavedDownload(
    val displayName: String,
    val uri: Uri,
)

/** True when saving to Downloads needs the legacy storage permission (Android 9 and older). */
fun savingDownloadsNeedsPermission(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q

/**
 * Copies [source] into `Download/Agents Anywhere/` under [displayName], keeping
 * the original name and extension. Uses MediaStore on Android 10+ and the
 * public directory (with WRITE_EXTERNAL_STORAGE) on older versions.
 */
suspend fun saveFileToDownloads(
    context: Context,
    source: File,
    displayName: String,
): Result<SavedDownload> = saveDownload(context, displayName) { output ->
    source.inputStream().use { input -> input.copyTo(output, 64 * 1024) }
}

internal suspend fun saveCsvToDownloads(
    context: Context,
    displayName: String,
    csv: String,
): Result<SavedDownload> = saveDownload(context, displayName, mimeType = "text/csv") { output ->
    output.write(csv.toByteArray(Charsets.UTF_8))
}

private suspend fun saveDownload(
    context: Context,
    displayName: String,
    mimeType: String? = null,
    write: (OutputStream) -> Unit,
): Result<SavedDownload> = withContext(Dispatchers.IO) {
    runCatching {
        val name = localFileName(displayName)
        val resolvedMimeType = mimeType ?: downloadsMimeType(name) { extension ->
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveWithMediaStore(context, name, resolvedMimeType, write)
        } else {
            saveToPublicDirectory(context, name, resolvedMimeType, write)
        }
    }
}

@RequiresApi(Build.VERSION_CODES.Q)
private fun saveWithMediaStore(
    context: Context,
    name: String,
    mimeType: String,
    write: (OutputStream) -> Unit,
): SavedDownload {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mimeType)
        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_SUBFOLDER")
        put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val uri = resolver.insert(collection, values) ?: error("Unable to create the download.")
    try {
        val output = resolver.openOutputStream(uri, "w") ?: error("Unable to write the download.")
        output.use(write)
        val published = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
        check(resolver.update(uri, published, null, null) == 1) { "Unable to publish the download." }
    } catch (error: Throwable) {
        runCatching { resolver.delete(uri, null, null) }
        throw error
    }
    val savedName = runCatching {
        resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull() ?: name
    return SavedDownload(displayName = savedName, uri = uri)
}

@Suppress("DEPRECATION")
private fun saveToPublicDirectory(
    context: Context,
    name: String,
    mimeType: String,
    write: (OutputStream) -> Unit,
): SavedDownload {
    val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    val directory = File(downloads, DOWNLOADS_SUBFOLDER)
    directory.mkdirs()
    check(directory.isDirectory) { "Unable to create the download folder." }
    var target: File
    do {
        target = uniqueDownloadFile(directory, name)
    } while (!target.createNewFile())
    try {
        target.outputStream().use(write)
    } catch (error: Throwable) {
        runCatching { target.delete() }
        throw error
    }
    MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(mimeType), null)
    return SavedDownload(displayName = target.name, uri = Uri.fromFile(target))
}

/** `报告.pdf`, then `报告 (1).pdf`, `报告 (2).pdf`, ... like the system Downloads app. */
fun uniqueDownloadFile(directory: File, name: String): File {
    val first = File(directory, name)
    if (!first.exists()) return first
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val extension = if (dot > 0) name.substring(dot) else ""
    var index = 1
    while (true) {
        val candidate = File(directory, "$stem ($index)$extension")
        if (!candidate.exists()) return candidate
        index += 1
    }
}
