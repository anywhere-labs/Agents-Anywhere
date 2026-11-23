package dev.agentsanywhere.v3.bridge

import android.annotation.SuppressLint
import android.app.Application
import android.content.Context
import android.content.MutableContextWrapper
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.agentsanywhere.v3.BuildConfig
import dev.agentsanywhere.v3.core.bool
import dev.agentsanywhere.v3.core.bridge.BridgeOutbox
import dev.agentsanywhere.v3.core.double
import dev.agentsanywhere.v3.core.jsonOf
import dev.agentsanywhere.v3.core.str
import kotlinx.serialization.json.JsonObject

/**
 * The app's one long-lived WebView and the `aa.render/2` bridge to the web-v3 render bundle inside it
 * (docs/v3/mobile-bridge.md):
 *  - page → native: `window.AndroidAA.postMessage(JSON.stringify(obj))` (`@JavascriptInterface`);
 *  - native → page: `evaluateJavascript("window.aa.receive(<json>)")`;
 *  - nothing but queuing before the page's `ready`; messages of one frame (~16 ms) go out as one `batch`.
 * The page never touches the network: conversation events, terminal frames and file bytes all come from here.
 * The conversation and terminal screens re-parent the same WebView and switch it with `view.*` messages.
 * Main thread only (the JavaScript interface hops to it).
 */
class RenderBridge(private val app: Application) {
    sealed class Phase {
        data object Loading : Phase()
        data object Ready : Phase()
        data class Failed(val message: String) : Phase()
    }

    var phase by mutableStateOf<Phase>(Phase.Loading); private set
    /** From `scroll_state`: native shows the 回到底部 button when false. */
    var atBottom by mutableStateOf(true); private set
    var webView by mutableStateOf<WebView?>(null); private set
    var generation by mutableIntStateOf(0); private set
    /** Which screen hosts the WebView right now (pushed screens take it over; the one below lets go). */
    var host by mutableStateOf<Any?>(null)
    val usesPlaceholder: Boolean get() = !assets.hasBundle

    /** Page messages other than `ready` / `scroll_state`, for the screen on top. */
    var onMessage: (JsonObject) -> Unit = {}
    /** After every `ready` (first load and reloads): the screen re-sends its view and content. */
    var onReady: () -> Unit = {}

    private val assets = RenderAssets(app)
    private val outbox = BridgeOutbox()
    private val context = MutableContextWrapper(app)
    private val main = Handler(Looper.getMainLooper())
    private var frameScheduled = false
    private var lastTheme: JsonObject? = null
    private var lastLocale: JsonObject? = null

    val isReady: Boolean get() = phase == Phase.Ready

    fun start() {
        if (webView == null) create()
    }

    fun attach(activityContext: Context?) {
        context.baseContext = activityContext ?: app
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun create() {
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(context)
        view.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        // Glass over the thread records the WebView (Kyant backdrop): drawn into its own hardware layer it is recorded
        // as one texture instead of Chromium's draw functor being replayed per glass control.
        view.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100 // the page scales its own text from `theme.font_scale`
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
            offscreenPreRaster = true
            // No network for the page: everything it shows comes through the bridge.
            blockNetworkLoads = true
        }
        view.addJavascriptInterface(JsInterface(), "AndroidAA")
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        webView = view
        generation++
        load()
    }

    fun load() {
        val view = webView ?: return
        phase = Phase.Loading
        outbox.reset(dropQueued = true)
        view.loadUrl(assets.url)
        val gen = generation
        main.postDelayed({
            if (gen == generation && phase == Phase.Loading) phase = Phase.Failed("The renderer did not say ready within 10 s.")
        }, 10_000)
    }

    // Native → page

    /** Queues one message (`v: 2` is added); sent on the next frame once the page is ready. */
    fun send(message: JsonObject) {
        if (outbox.enqueue(message)) schedule()
    }

    fun send(type: String, vararg fields: Pair<String, Any?>) = send(jsonOf("type" to type, *fields))

    /** Appearance and the safe area covered by native glass (CSS px = dp); re-sent when it changes and after `ready`. */
    fun setTheme(dark: Boolean, top: Float, bottom: Float, fontScale: Float, reduceMotion: Boolean, highContrast: Boolean) {
        val message = jsonOf("type" to "theme", "scheme" to if (dark) "dark" else "light",
            "insets" to mapOf("top" to Math.round(top), "bottom" to Math.round(bottom), "left" to 0, "right" to 0),
            "font_scale" to Math.round(fontScale * 100) / 100.0, "reduce_motion" to reduceMotion, "high_contrast" to highContrast)
        if (message == lastTheme) return
        lastTheme = message
        send(message)
    }

    fun setLocale(locale: String) {
        val message = jsonOf("type" to "locale", "locale" to if (locale.startsWith("zh")) "zh-CN" else "en")
        if (message == lastLocale) return
        lastLocale = message
        send(message)
    }

    fun scroll(to: String) = send("scroll", "to" to to)

    private fun schedule() {
        if (frameScheduled) return
        frameScheduled = true
        // One evaluateJavascript per frame (~16 ms): everything queued meanwhile goes as one batch.
        Choreographer.getInstance().postFrameCallback { frameScheduled = false; flush() }
    }

    private fun flush() {
        val view = webView ?: return
        val script = outbox.drain() ?: return
        view.evaluateJavascript(script, null)
    }

    // Page → native

    private inner class JsInterface {
        @JavascriptInterface
        fun postMessage(json: String) {
            main.post { receive(json) }
        }
    }

    private fun receive(json: String) {
        val body = BridgeOutbox.parseInbound(json) ?: return
        when (body["type"].str) {
            "ready" -> {
                outbox.reset(dropQueued = true)
                outbox.markReady(body)
                phase = Phase.Ready
                lastTheme?.let { send(it) }
                lastLocale?.let { send(it) }
                onReady()
            }
            "scroll_state" -> atBottom = body["at_bottom"].bool ?: ((body["distance"].double ?: 0.0) < 24)
            else -> onMessage(body)
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.intercept(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // The page never navigates away; links go to the system like `open_link`.
            onMessage(jsonOf("v" to 2, "type" to "open_link", "url" to request.url.toString()))
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "renderer process gone (crashed=${detail.didCrash()}); recreating the WebView")
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            if (view === webView) {
                webView = null
                phase = Phase.Loading
                outbox.reset(dropQueued = true)
                main.post { create() }
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                Log.w(TAG, "js ${message.messageLevel().name.lowercase()}: ${message.message()} @${message.sourceId()?.takeLast(40)}:${message.lineNumber()}")
            }
            return true
        }
    }

    companion object {
        const val TAG = "AAv3"
    }
}
