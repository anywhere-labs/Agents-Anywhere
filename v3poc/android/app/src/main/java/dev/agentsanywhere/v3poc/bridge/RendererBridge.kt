package dev.agentsanywhere.v3poc.bridge

import android.annotation.SuppressLint
import android.app.Application
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.agentsanywhere.v3poc.BuildConfig
import dev.agentsanywhere.v3poc.LaunchClock
import dev.agentsanywhere.v3poc.model.AAJson
import dev.agentsanywhere.v3poc.model.get
import dev.agentsanywhere.v3poc.model.jsObj
import dev.agentsanywhere.v3poc.model.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * `aa.render/1`: the app's one long-lived WebView and the message pipe to the renderer inside it.
 * Native → renderer: `evaluateJavascript("window.aaRenderer.receive(…)")`. Renderer → native: the `aaHost` web
 * message listener (androidx.webkit), restricted to the asset loader's origin.
 *
 * Sending: watch events are coalesced by id (a newer push of an item replaces the queued one) and sent at most once
 * per frame, and never while the previous `evaluateJavascript` has not called back. On iOS an uncoalesced bridge
 * backed up to 16–21 calls in flight and the renderer applied stale versions; here at most one call is in flight.
 * Main thread only.
 */
class RendererBridge(private val app: Application) {
    sealed class Phase {
        data object Loading : Phase()
        data class Ready(val renderer: String) : Phase()
        /** The APK has no assets/renderer/renderer.html. */
        data object Missing : Phase()
        data class Failed(val message: String) : Phase()
    }

    var phase by mutableStateOf<Phase>(Phase.Loading); private set
    /** From the renderer's `scroll` message; native draws the 到底部 pill. */
    var atEnd by mutableStateOf(true); private set
    /** The WebView currently in use; replaced when the renderer process dies. */
    var webView by mutableStateOf<WebView?>(null); private set
    /** Bumped every time a WebView is created (Compose re-parents the new one). */
    var generation by mutableIntStateOf(0); private set
    var readyAfterMs: Long? = null; private set

    /** The snapshot of the session on screen; sent again whenever the renderer (re)becomes ready. */
    var currentSnapshot: () -> JsonObject? = { null }
    /** Renderer messages other than `ready` / `scroll`. */
    var onMessage: (JsonObject) -> Unit = {}
    /** A finger started dragging the thread (like `keyboardDismissMode = .onDrag` on the WebView's own scroll view). */
    var onUserDrag: () -> Unit = {}
    /** Called after `ready` (first load and every reload). */
    var onReady: () -> Unit = {}

    private val assets = RendererAssets(app)
    private val context = MutableContextWrapper(app)
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // Outgoing state
    private var pendingSnapshot: JsonObject? = null
    private val pendingEvents = LinkedHashMap<String, JsonElement>()
    private val pendingHost = ArrayList<JsonObject>()
    private var inFlight = false
    private var frameScheduled = false
    private var lastSnapshot: JsonObject? = null
    private var eventsSinceSnapshot = 0
    private var lastViewport: JsonObject? = null
    private var lastAppearance: JsonObject? = null
    private var loadStartedAt = 0L
    private var eventSequence = 0L

    val isReady: Boolean get() = phase is Phase.Ready

    fun start() {
        if (webView == null) create()
    }

    /** The Activity the WebView currently lives in (dialogs, IME); the application context when there is none. */
    fun attach(activityContext: Context?) {
        context.baseContext = activityContext ?: app
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create() {
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(context)
        view.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        // Glass records the thread (Kyant backdrop). Drawn into its own hardware layer (plus offscreenPreRaster, `both`), the WebView is recorded as one
        // texture instead of having Chromium's draw functor replayed for every glass control with a RenderEffect on
        // it, which flickered and exceeded Chromium's tile memory (Kyant backdrop #16 / Haze #99).
        val layerMode = dev.agentsanywhere.v3poc.DebugLaunch.webLayer
        if (layerMode == "hw" || layerMode == "both") view.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        view.isVerticalScrollBarEnabled = true
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        // Long-pressing a link would start a link preview/drag; text selection still works.
        // Observes only (returns false): the WebView still gets every event exactly as without the listener. This is on
        // the WebView itself, not on an ancestor, so nothing arbitrates its touches.
        val slop = android.view.ViewConfiguration.get(app).scaledTouchSlop
        var downY = 0f
        var reported = false
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> { downY = e.y; reported = false }
                android.view.MotionEvent.ACTION_MOVE -> if (!reported && kotlin.math.abs(e.y - downY) > slop) { reported = true; onUserDrag() }
            }
            false
        }
        view.setOnLongClickListener { (it as WebView).hitTestResult.type.let { type -> type == WebView.HitTestResult.SRC_ANCHOR_TYPE || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE || type == WebView.HitTestResult.IMAGE_TYPE } }
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // The renderer scales its own text from `appearance.textScale`; the WebView must not scale it again.
            textZoom = 100
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            loadWithOverviewMode = false
            useWideViewPort = true
            setGeolocationEnabled(false)
            if (layerMode == "preraster" || layerMode == "both") offscreenPreRaster = true
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, "aaHost", setOf(RendererAssets.ORIGIN)) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let { receive(it) }
            }
            if (StressMetrics.enabled) {
                WebViewCompat.addWebMessageListener(view, "aaStress", setOf(RendererAssets.ORIGIN)) { _, message, _, _, _ ->
                    message.data?.let(StressMetrics::renderer)
                }
            }
        } else {
            phase = Phase.Failed("这个 WebView 版本不支持 WebMessageListener，请更新 Android System WebView。")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, BOOT_PROBE, setOf(RendererAssets.ORIGIN))
            if (StressMetrics.enabled) WebViewCompat.addDocumentStartJavaScript(view, StressMetrics.probeScript, setOf(RendererAssets.ORIGIN))
        }
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        webView = view
        generation++
        LaunchClock.mark("WebView created (generation $generation, ${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"}, layer $layerMode)")
        load()
    }

    fun load() {
        val view = webView ?: return
        if (!assets.hasRenderer) {
            phase = Phase.Missing
            LaunchClock.log("assets/renderer/renderer.html is missing (copyPocAssets copies v3poc/ios/AAv3PoC/Renderer/renderer.html)")
            return
        }
        if (phase is Phase.Failed && !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        phase = Phase.Loading
        resetOutbox()
        loadStartedAt = SystemClock.uptimeMillis()
        LaunchClock.mark("load ${RendererAssets.RENDERER_URL}")
        view.loadUrl(RendererAssets.RENDERER_URL)
    }

    private fun resetOutbox() {
        pendingSnapshot = null
        pendingEvents.clear()
        pendingHost.clear()
        inFlight = false
        lastSnapshot = null
    }

    // Native → renderer

    /** Watch events for the session on screen: coalesced by id, sent once per frame. */
    fun enqueue(event: JsonObject) {
        if (!isReady) return // The snapshot sent on `ready` already contains it.
        val key = when (event["type"].str) {
            "message" -> "m:" + (event["message"]["id"].str ?: (eventSequence++).toString())
            "session" -> "session"
            "control" -> "control"
            else -> "e:${eventSequence++}"
        }
        val replaced = pendingEvents.put(key, event) != null
        eventsSinceSnapshot++
        StressMetrics.batch(pendingEvents.size, replaced)
        schedule()
    }

    /** Opening a session = sending its snapshot. Queued events belong to the previous session. */
    fun show(snapshot: JsonObject) {
        if (!isReady) return
        // Don't send the same snapshot twice in a row (cache, then an identical watch snapshot): on iOS that doubled
        // the cost of opening long sessions.
        if (eventsSinceSnapshot == 0 && pendingSnapshot == null && lastSnapshot != null && lastSnapshot == snapshot) {
            StressMetrics.event("snapshotSkipped")
            return
        }
        pendingEvents.clear()
        pendingSnapshot = snapshot
        lastSnapshot = snapshot
        eventsSinceSnapshot = 0
        schedule()
    }

    /** CSS px (= dp) covered by native chrome at the top and bottom. */
    fun setViewport(top: Float, bottom: Float) {
        val message = jsObj("type" to "viewport", "top" to Math.round(top), "bottom" to Math.round(bottom))
        if (message == lastViewport) return
        lastViewport = message
        sendHost(message)
    }

    fun setAppearance(dark: Boolean, textScale: Float, reduceMotion: Boolean, locale: String, accountName: String) {
        val message = jsObj("type" to "appearance", "scheme" to if (dark) "dark" else "light", "textScale" to Math.round(textScale * 100) / 100.0,
            "reduceMotion" to reduceMotion, "locale" to locale, "account" to jsObj("name" to accountName))
        if (message == lastAppearance) return
        lastAppearance = message
        sendHost(message)
    }

    fun scrollToEnd(animated: Boolean = true) = sendHost(jsObj("type" to "scrollToEnd", "animated" to animated))

    fun older(messages: List<JsonElement>, hasMore: Boolean) = sendHost(jsObj("type" to "older", "messages" to JsonArray(messages), "has_more" to hasMore))

    /** `ComponentCallbacks2.onTrimMemory`: the renderer may drop what it can rebuild (protocol addition in progress). */
    /** The strongest `memoryPressure` sent to this page; sent again when the page reloads (renderer levels reset). */
    var pressure: String? = null; private set

    /** The OS is short of memory: the renderer drops off-screen DOM and older items (`aa.render/1` memoryPressure). */
    fun memoryPressure(level: String) {
        if (pressure != "critical") pressure = level
        StressMetrics.event("memoryPressure", mapOf("level" to level))
        sendHost(jsObj("type" to "memoryPressure", "level" to level))
    }

    /** Debug: scroll the document up like a reader's drag would. */
    fun scrollUp(dp: Int) {
        val view = webView ?: return
        view.evaluateJavascript("window.scrollBy({top: -$dp, behavior: 'smooth'}); void 0", null)
    }

    /** Debug: kill the renderer process the way a crash would (`onRenderProcessGone` then recreates the WebView). */
    fun crashRenderer() {
        LaunchClock.log("debug: chrome://crash")
        webView?.loadUrl("chrome://crash")
    }

    private fun sendHost(message: JsonObject) {
        if (!isReady) return
        pendingHost += message
        schedule()
    }

    private fun schedule() {
        if (frameScheduled || inFlight) return
        frameScheduled = true
        Choreographer.getInstance().postFrameCallback { frameScheduled = false; flush() }
    }

    /**
     * One `evaluateJavascript` per frame: the snapshot (if a session was opened), then the coalesced watch events in
     * one `watch` message, then host messages (viewport, appearance, scrollToEnd…) in the order they were made.
     */
    private fun flush() {
        val view = webView ?: return
        if (inFlight || !isReady) return
        val snapshot = pendingSnapshot
        val events = pendingEvents.values.toList()
        val host = pendingHost.toList()
        if (snapshot == null && events.isEmpty() && host.isEmpty()) return
        pendingSnapshot = null
        pendingEvents.clear()
        pendingHost.clear()
        inFlight = true
        val generationAtSend = generation
        scope.launch {
            var encodeNanos = 0L
            // Encoding a long session's snapshot (tens of MB) must not block the main thread.
            val script = withContext(Dispatchers.Default) {
                val started = SystemClock.elapsedRealtimeNanos()
                val sb = StringBuilder("(function(r){")
                if (snapshot != null) sb.append("r.receive(").append(jsObj("type" to "watch", "events" to listOf(snapshot)).toString()).append(");")
                if (events.isNotEmpty()) sb.append("r.receive(").append(jsObj("type" to "watch", "events" to events).toString()).append(");")
                for (m in host) sb.append("r.receive(").append(m.toString()).append(");")
                sb.append("})(window.aaRenderer); void 0")
                sb.toString().also { encodeNanos = SystemClock.elapsedRealtimeNanos() - started }
            }
            // The encoding itself (as on iOS), without the hop to the background thread and back.
            val encodeMs = encodeNanos / 1e6
            if (generationAtSend != generation || webView !== view) return@launch // The renderer was replaced meanwhile.
            val done = StressMetrics.willEvaluate(
                events = events.size + (if (snapshot != null) 1 else 0),
                messageEvents = events.count { it["type"].str == "message" },
                bytes = script.length, encodeMs = encodeMs, isSnapshot = snapshot != null,
            )
            view.evaluateJavascript(script) {
                done()
                if (generationAtSend != generation) return@evaluateJavascript
                inFlight = false
                if (pendingSnapshot != null || pendingEvents.isNotEmpty() || pendingHost.isNotEmpty()) schedule()
            }
        }
    }

    // Renderer → native

    private fun receive(json: String) {
        val body = runCatching { AAJson.parseToJsonElement(json) as JsonObject }.getOrNull() ?: return
        when (body["type"].str) {
            "ready" -> {
                val renderer = body["renderer"].str ?: "?"
                if (readyAfterMs == null) readyAfterMs = LaunchClock.milliseconds()
                LaunchClock.mark("renderer ready ($renderer, protocol ${body["protocol"].str}, ${SystemClock.uptimeMillis() - loadStartedAt}ms after load start)")
                phase = Phase.Ready(renderer)
                StressMetrics.event("ready", mapOf("sinceLoadMs" to SystemClock.uptimeMillis() - loadStartedAt))
                resetOutbox()
                sendHost(jsObj("type" to "chrome", "approvals" to "host"))
                lastAppearance?.let { sendHost(it) }
                lastViewport?.let { sendHost(it) }
                pressure?.let { sendHost(jsObj("type" to "memoryPressure", "level" to it)) }
                currentSnapshot()?.let { show(it) }
                onReady()
            }
            "_boot" -> {
                // Startup phases from the page (performance.now() is relative to the navigation start).
                val fields = body.filterKeys { it != "type" && it != "phase" }.entries.joinToString(" ") { (k, v) -> "$k=${v.toString().substringBefore('.')}" }
                LaunchClock.mark("page ${body["phase"].str} ($fields)")
            }
            "scroll" -> {
                atEnd = body["atEnd"].let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content != "false" }
                StressMetrics.event("scroll", mapOf("atEnd" to atEnd))
            }
            else -> onMessage(body)
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.intercept(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Never navigate away from the renderer: links open natively.
            onMessage(jsObj("type" to "open", "target" to jsObj("kind" to "url", "url" to request.url.toString())))
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = LaunchClock.mark("page started")

        override fun onPageFinished(view: WebView, url: String?) {
            LaunchClock.mark("page finished")
            val gen = generation
            main.postDelayed({
                // A page without the bridge never says `ready`.
                if (gen == generation && phase is Phase.Loading) phase = Phase.Failed("渲染器加载完成，但 5 秒内没有发送 ready。")
            }, 5000)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Returning false kills the app. Every WebView sharing the dead process is unusable: drop it, make a new
            // one, load the renderer again; `ready` then resends chrome, appearance, viewport and the snapshot.
            LaunchClock.log("renderer process gone (crashed=${detail.didCrash()}, priority=${detail.rendererPriorityAtExit()}); recreating the WebView")
            StressMetrics.event("rendererGone", mapOf("crashed" to detail.didCrash()))
            // Not a crash: the system reclaimed the renderer's memory. The reloaded page starts with the smaller
            // windows of `memoryPressure: warning`.
            if (!detail.didCrash() && pressure == null) pressure = "warning"
            if (view === webView) {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                webView = null
                phase = Phase.Loading
                resetOutbox()
                main.post { create() }
            } else {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                LaunchClock.log("js ${message.messageLevel().name.lowercase()}: ${message.message()} @${message.sourceId()?.takeLast(40)}:${message.lineNumber()}")
            }
            return true
        }
    }

    private companion object {
        /** Posts the document-start and DOMContentLoaded moments plus navigation timing, for the launch log. */
        const val BOOT_PROBE = """(function () {
  var host = window.aaHost; if (!host) return;
  function post(phase, extra) { var m = { type: '_boot', phase: phase, t: performance.now() }; for (var k in extra || {}) m[k] = extra[k]; host.postMessage(JSON.stringify(m)); }
  post('documentStart');
  document.addEventListener('DOMContentLoaded', function () {
    var n = performance.getEntriesByType('navigation')[0] || {};
    post('domContentLoaded', { responseStart: n.responseStart, responseEnd: n.responseEnd, domInteractive: n.domInteractive });
  });
})();"""
    }
}
