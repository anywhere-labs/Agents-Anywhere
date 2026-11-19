package dev.agentsanywhere.v3poc.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayOutputStream

/**
 * Serves `https://appassets.androidplatform.net/renderer/renderer.html` from the generated assets (assets/renderer/),
 * and `aa-app://file?path=…` (the URL the renderer builds for image parts, see v3poc/web/src/renderer/main.tsx) as a
 * generated placeholder. The page never sees credentials: a real app would fetch the attachment here with its own token.
 */
class RendererAssets(private val context: Context) {
    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val RENDERER_URL = "$ORIGIN/renderer/renderer.html"
        const val FILE_SCHEME = "aa-app"
    }

    val hasRenderer: Boolean = runCatching { context.assets.open("renderer/renderer.html").close(); true }.getOrDefault(false)

    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/renderer/") { path ->
            // Only the renderer directory; nothing else in assets is reachable from the page.
            runCatching {
                val stream = context.assets.open("renderer/$path")
                WebResourceResponse(if (path.endsWith(".html")) "text/html" else "application/octet-stream", "utf-8",
                    if (path == "renderer.html") TimedStream(stream, path) else stream).apply {
                    responseHeaders = mapOf("Cache-Control" to "no-store")
                }
            }.getOrNull()
        }
        .build()

    fun intercept(uri: Uri): WebResourceResponse? {
        if (uri.scheme == FILE_SCHEME && uri.host == "file" || uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path == "/file") {
            val path = uri.getQueryParameter("path") ?: "file"
            return WebResourceResponse("image/png", null, placeholderImage(path.substringAfterLast('/')).inputStream()).apply {
                responseHeaders = mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to ORIGIN)
            }
        }
        return loader.shouldInterceptRequest(uri)
    }

    /** A screenshot-like placeholder with the whole file name, standing in for an attachment fetched with the user's token. */
    fun placeholderImage(name: String): ByteArray {
        val scale = 2f
        val w = 480f; val h = 320f
        val bitmap = Bitmap.createBitmap((w * scale).toInt(), (h * scale).toInt(), Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        c.scale(scale, scale)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.shader = LinearGradient(0f, 0f, w, h, 0xFFE6EDF7.toInt(), 0xFFCCDBF0.toInt(), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
        paint.color = 0xD9FFFFFF.toInt()
        c.drawRoundRect(RectF(32f, 32f, 448f, 228f), 18f, 18f, paint)
        paint.color = 0xFFC7C7C7.toInt()
        listOf(260f, 340f, 300f, 220f).forEachIndexed { i, bw -> c.drawRoundRect(RectF(56f, 60f + i * 36, 56f + bw, 74f + i * 36), 7f, 7f, paint) }
        paint.color = 0xFF34C759.toInt()
        c.drawOval(RectF(404f, 54f, 424f, 74f), paint)
        // Centered and shrunk until it fits: renderers crop thumbnails to their own aspect ratio, the name must stay whole.
        paint.color = 0xFF404040.toInt()
        paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        paint.textAlign = Paint.Align.CENTER
        var size = 22f
        paint.textSize = size
        while (paint.measureText(name) > w - 120 && size > 9f) { size -= 1f; paint.textSize = size }
        c.drawText(name, w / 2, 266f, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return out.toByteArray()
    }
}

/** Logs when Chromium starts and finishes reading an asset (startup timing: how long the 16 MB renderer takes to stream). */
private class TimedStream(private val inner: java.io.InputStream, private val name: String) : java.io.FilterInputStream(inner) {
    private var bytes = 0L
    private var started = false
    private var ended = false

    private fun count(n: Int): Int {
        if (!started) { started = true; dev.agentsanywhere.v3poc.LaunchClock.mark("asset $name: first read") }
        if (n > 0) bytes += n
        if (n < 0 && !ended) { ended = true; dev.agentsanywhere.v3poc.LaunchClock.mark("asset $name: read ${bytes / 1024} KB") }
        return n
    }

    override fun read(): Int = super.read().also { count(if (it < 0) -1 else 1) }
    override fun read(b: ByteArray, off: Int, len: Int): Int = count(super.read(b, off, len))
}
