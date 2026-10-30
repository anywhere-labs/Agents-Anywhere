package com.agentsanywhere.app.feature.attachment

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

data class CompressedImage(
    /** Compressed output, or null when the original should be uploaded as-is. */
    val file: File?,
    val name: String,
    val mediaType: String,
    val sourceSize: Long,
)

/**
 * Shrinks camera photos before they are uploaded.
 *
 * A modern phone camera produces 4000x3000 JPEGs of 4-8 MB. The server stores the
 * original and the timeline then downloads it again for every device, so uploading
 * full-resolution photos is by far the most expensive thing the app does on a chat
 * turn. Downscaling to [MAX_EDGE] and re-encoding at [QUALITY] cuts the payload by
 * 80-95% with no visible difference on a phone or tablet screen.
 */
object ImageCompressor {
    const val MAX_EDGE = 2048
    const val QUALITY = 85

    /** Files below this size that already fit [MAX_EDGE] are uploaded untouched. */
    private const val SKIP_BELOW_BYTES = 512L * 1024L

    private val passthroughTypes = setOf("image/gif", "image/svg+xml")

    suspend fun compress(
        context: Context,
        uri: Uri,
        name: String,
        mediaType: String,
    ): CompressedImage = withContext(Dispatchers.IO) {
        val normalizedType = mediaType.trim().lowercase()
        val original = CompressedImage(
            file = null,
            name = name,
            mediaType = normalizedType,
            sourceSize = sourceSize(context, uri),
        )
        if (!normalizedType.startsWith("image/") || normalizedType in passthroughTypes) {
            return@withContext original
        }
        val bounds = readBounds(context, uri) ?: return@withContext original
        val longestEdge = max(bounds.first, bounds.second)
        if (longestEdge <= 0) return@withContext original
        if (longestEdge <= MAX_EDGE && original.sourceSize in 1..SKIP_BELOW_BYTES) {
            return@withContext original
        }
        val bitmap = runCatching { decode(context, uri, bounds) }.getOrNull()
            ?: return@withContext original
        val encoded = try {
            encode(context, bitmap, name, normalizedType)
        } finally {
            bitmap.recycle()
        }
        if (encoded == null) return@withContext original
        val encodedFile = encoded.file ?: return@withContext original
        if (original.sourceSize > 0 && encodedFile.length() >= original.sourceSize) {
            encodedFile.delete()
            return@withContext original
        }
        encoded
    }

    private fun sourceSize(context: Context, uri: Uri): Long {
        return runCatching {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: 0L
        }.getOrDefault(0L)
    }

    private fun readBounds(context: Context, uri: Uri): Pair<Int, Int>? {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        val width = options.outWidth
        val height = options.outHeight
        return if (width > 0 && height > 0) width to height else null
    }

    private fun decode(context: Context, uri: Uri, bounds: Pair<Int, Int>): Bitmap? {
        val (width, height) = bounds
        val scale = (MAX_EDGE.toFloat() / max(width, height).toFloat()).coerceAtMost(1f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.isMutableRequired = false
                if (scale < 1f) {
                    decoder.setTargetSize(
                        (info.size.width * scale).roundToInt().coerceAtLeast(1),
                        (info.size.height * scale).roundToInt().coerceAtLeast(1),
                    )
                }
            }
        }
        @Suppress("DEPRECATION")
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(width, height)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, options)
        } ?: return null
        val rotated = applyExifRotation(context, uri, decoded)
        if (rotated !== decoded) decoded.recycle()
        if (scale >= 1f) return rotated
        val targetWidth = (rotated.width * scale).roundToInt().coerceAtLeast(1)
        val targetHeight = (rotated.height * scale).roundToInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(rotated, targetWidth, targetHeight, true)
        if (scaled !== rotated) rotated.recycle()
        return scaled
    }

    private fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        while (max(width / sample, height / sample) > MAX_EDGE * 2) sample *= 2
        return sample
    }

    private fun applyExifRotation(context: Context, uri: Uri, bitmap: Bitmap): Bitmap {
        val orientation = runCatching {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                ExifInterface(stream).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL,
                )
            }
        }.getOrNull() ?: return bitmap
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            else -> return bitmap
        }
        return runCatching {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        }.getOrDefault(bitmap)
    }

    private fun encode(context: Context, bitmap: Bitmap, name: String, mediaType: String): CompressedImage? {
        val hasAlpha = bitmap.hasAlpha()
        val format = if (hasAlpha) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
        } else {
            Bitmap.CompressFormat.JPEG
        }
        val extension = if (hasAlpha) "webp" else "jpg"
        val outputType = if (hasAlpha) "image/webp" else "image/jpeg"
        val directory = File(context.cacheDir, "upload_tmp").apply { mkdirs() }
        val file = File(directory, "${UUID.randomUUID()}.$extension")
        val written = runCatching {
            file.outputStream().use { stream -> bitmap.compress(format, QUALITY, stream) }
        }.getOrDefault(false)
        if (!written) {
            file.delete()
            return null
        }
        return CompressedImage(
            file = file,
            name = name.replaceExtension(extension),
            mediaType = outputType,
            sourceSize = 0L,
        )
    }

    private fun String.replaceExtension(extension: String): String {
        val dot = lastIndexOf('.')
        val slash = max(lastIndexOf('/'), lastIndexOf('\\'))
        return if (dot > slash + 1) substring(0, dot) + "." + extension else "$this.$extension"
    }
}
