package dev.agentsanywhere.v3.bridge

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader

/**
 * Serves the render bundle from the APK at `https://appassets.androidplatform.net/render/…`. The real bundle
 * (`render/aa-render.html`, copied by the `copyRenderBundle` Gradle task) is preferred; the placeholder page ships in
 * the APK so the app works before the bundle is built. Nothing else in assets is reachable from the page, and the page
 * has no network: file bytes come through the bridge (`file.read`).
 */
class RenderAssets(private val context: Context) {
    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val BUNDLE = "render/aa-render.html"
        const val PLACEHOLDER = "render/placeholder.html"
    }

    val hasBundle: Boolean = exists(BUNDLE)

    /** The page to load: the real bundle when the APK has it, else the placeholder. */
    val url: String = "$ORIGIN/" + if (hasBundle) BUNDLE else PLACEHOLDER

    private fun exists(path: String) = runCatching { context.assets.open(path).close(); true }.getOrDefault(false)

    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/render/") { path ->
            runCatching {
                val stream = context.assets.open("render/$path")
                val mime = when {
                    path.endsWith(".html") -> "text/html"
                    path.endsWith(".js") -> "text/javascript"
                    path.endsWith(".css") -> "text/css"
                    path.endsWith(".woff2") -> "font/woff2"
                    else -> "application/octet-stream"
                }
                WebResourceResponse(mime, "utf-8", stream).apply { responseHeaders = mapOf("Cache-Control" to "no-store") }
            }.getOrNull()
        }
        .build()

    fun intercept(uri: Uri): WebResourceResponse? = loader.shouldInterceptRequest(uri)
}
