package dev.agentsanywhere.v3poc.bridge

import android.app.Activity
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import androidx.metrics.performance.JankStats
import dev.agentsanywhere.v3poc.LaunchClock
import dev.agentsanywhere.v3poc.model.AAJson
import dev.agentsanywhere.v3poc.model.toJson
import kotlinx.serialization.json.JsonObject

/**
 * Measurements for the stress runs (on with `--es stress …` or `--ez metrics true`), the same lines as the iOS PoC's
 * StressMetrics: every 5 s one `[stress] {"k":"native",…}` with what the bridge sent and how the main thread kept up;
 * the renderer probe (a document-start script, the renderer itself is untouched) reports `{"k":"web",…}`.
 * Main thread only.
 */
object StressMetrics {
    var enabled = false
        private set

    private val start = SystemClock.elapsedRealtime()
    private var window = Window()
    private var inflight = 0
    private var lastFrameNanos = 0L
    private val handler = Handler(Looper.getMainLooper())
    private var jankStats: JankStats? = null

    private class Window {
        var flushes = 0; var events = 0; var messageEvents = 0; var bytes = 0L; var maxBytes = 0L; var maxEvents = 0
        var encodeMs = 0.0; var encodeMax = 0.0
        var evals = 0; var evalMs = 0.0; var evalMax = 0.0; var inflightMax = 0
        var frames = 0; var dropped = 0; var maxGap = 0.0
        var batchMax = 0; var coalesced = 0
        var jankFrames = 0; var jankMaxMs = 0.0
    }

    fun enable() {
        if (enabled) return
        enabled = true
        Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                if (lastFrameNanos > 0) {
                    val gap = (frameTimeNanos - lastFrameNanos) / 1e6
                    val expected = 1000.0 / refreshRate
                    window.frames++
                    if (gap > expected * 1.5) window.dropped += maxOf(1, Math.round(gap / expected).toInt() - 1)
                    window.maxGap = maxOf(window.maxGap, gap)
                }
                lastFrameNanos = frameTimeNanos
                Choreographer.getInstance().postFrameCallback(this)
            }
        })
        handler.postDelayed(object : Runnable {
            override fun run() { report(); handler.postDelayed(this, 5000) }
        }, 5000)
    }

    var refreshRate = 60f

    /** JankStats on the activity window: frames the platform marks as janky (UI + RenderThread time). */
    fun attach(activity: Activity) {
        if (!enabled) return
        @Suppress("DEPRECATION")
        refreshRate = if (android.os.Build.VERSION.SDK_INT >= 30) activity.display?.refreshRate ?: 60f else activity.windowManager.defaultDisplay.refreshRate
        jankStats = JankStats.createAndTrack(activity.window) { frame ->
            if (frame.isJank) {
                window.jankFrames++
                window.jankMaxMs = maxOf(window.jankMaxMs, frame.frameDurationUiNanos / 1e6)
            }
        }
    }

    // Bridge

    fun batch(length: Int, coalesced: Boolean) {
        window.batchMax = maxOf(window.batchMax, length)
        if (coalesced) window.coalesced++
    }

    /** One `evaluateJavascript`; returns the completion to call when its callback comes back. */
    fun willEvaluate(events: Int, messageEvents: Int, bytes: Int, encodeMs: Double, isSnapshot: Boolean): () -> Unit {
        if (!enabled) return {}
        window.flushes++
        window.events += events
        window.messageEvents += messageEvents
        window.bytes += bytes
        window.maxBytes = maxOf(window.maxBytes, bytes.toLong())
        window.maxEvents = maxOf(window.maxEvents, events)
        window.encodeMs += encodeMs
        window.encodeMax = maxOf(window.encodeMax, encodeMs)
        inflight++
        window.inflightMax = maxOf(window.inflightMax, inflight)
        val sent = SystemClock.elapsedRealtimeNanos()
        if (isSnapshot) log(mapOf("k" to "snapshotSent", "bytes" to bytes, "encodeMs" to r1(encodeMs)))
        return {
            val ms = (SystemClock.elapsedRealtimeNanos() - sent) / 1e6
            inflight--
            window.evals++
            window.evalMs += ms
            window.evalMax = maxOf(window.evalMax, ms)
            if (isSnapshot) log(mapOf("k" to "snapshotEval", "ms" to r1(ms), "bytes" to bytes))
        }
    }

    fun event(what: String, extra: Map<String, Any?> = emptyMap()) {
        if (!enabled) return
        log(extra + mapOf("k" to "event", "what" to what))
    }

    /** A message from the page probe (`aaStress`). */
    fun renderer(json: String) {
        if (!enabled) return
        val body = runCatching { AAJson.parseToJsonElement(json) as JsonObject }.getOrNull() ?: return
        val type = (body["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "web"
        log(body.toMap().filterKeys { it != "type" } + mapOf("k" to if (type == "window") "web" else type))
    }

    /** Where a control is on screen (px), so the host script can tap it: `[stress] {"k":"ui",…}`. */
    fun ui(name: String, x: Float?, y: Float?) {
        if (!enabled) return
        log(mapOf("k" to "ui", "name" to name, "x" to x?.toInt(), "y" to y?.toInt()))
    }

    private fun report() {
        val w = window
        window = Window()
        fun avg(total: Double, count: Int) = if (count > 0) r1(total / count) else 0.0
        log(mapOf("k" to "native",
            "flushes" to w.flushes, "events" to w.events, "msgEvents" to w.messageEvents,
            "kb" to r1(w.bytes / 1024.0), "maxKB" to r1(w.maxBytes / 1024.0), "maxEventsPerFlush" to w.maxEvents, "batchMax" to w.batchMax,
            "coalesced" to w.coalesced,
            "encodeAvg" to avg(w.encodeMs, w.flushes), "encodeMax" to r1(w.encodeMax),
            "evalAvg" to avg(w.evalMs, w.evals), "evalMax" to r1(w.evalMax),
            "inflightMax" to w.inflightMax, "inflightNow" to inflight,
            "uiFrames" to w.frames, "uiDropped" to w.dropped, "uiMaxGap" to r1(w.maxGap),
            "jank" to w.jankFrames, "jankMaxMs" to r1(w.jankMaxMs),
            "appMB" to r1(Debug.getPss() / 1024.0)))
    }

    fun log(fields: Map<String, Any?>) {
        val all = LinkedHashMap<String, Any?>(fields)
        all["t"] = r1((SystemClock.elapsedRealtime() - start) / 1000.0)
        all["wall"] = r1(System.currentTimeMillis() / 1000.0)
        LaunchClock.log("[stress] " + toJson(all).toString())
    }

    private fun r1(v: Double) = Math.round(v * 10) / 10.0

    /**
     * Measures the renderer from inside the page without changing it (the iOS probe, posting to `aaStress`):
     * rAF gaps, time in `aaRenderer.receive`, receive → second following frame (≈ painted), DOM size, heap.
     */
    val probeScript = """
    (() => {
      const post = m => { try { window.aaStress.postMessage(JSON.stringify(m)) } catch {} }
      const fresh = () => ({ frames: 0, dropped: 0, maxGap: 0, gaps50: 0, gaps100: 0, recv: 0, recvMs: 0, recvMax: 0,
                             paintMs: 0, paintMax: 0, paints: 0, added: 0, removed: 0, textChanges: 0, mutationBatches: 0 })
      let w = fresh(), last = 0
      const raf = t => {
        if (last) { const gap = t - last; w.frames++; if (gap > 25) w.dropped += Math.round(gap / 16.67) - 1
          if (gap > w.maxGap) w.maxGap = gap; if (gap > 50) w.gaps50++; if (gap > 100) w.gaps100++ }
        last = t; requestAnimationFrame(raf)
      }
      requestAnimationFrame(raf)
      let current
      const wrap = r => {
        if (!r || r.__aaProbe) return r
        const original = r.receive.bind(r)
        r.receive = message => {
          const t0 = performance.now()
          try { return original(message) } finally {
            const d = performance.now() - t0
            w.recv++; w.recvMs += d; if (d > w.recvMax) w.recvMax = d
            const snapshot = message && message.type === 'watch' && message.events.find(e => e.type === 'snapshot')
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const p = performance.now() - t0
              w.paints++; w.paintMs += p; if (p > w.paintMax) w.paintMax = p
              if (snapshot) post({ type: 'snapshotRendered', ms: Math.round(p), receiveMs: Math.round(d), items: snapshot.messages.length,
                                   dom: document.getElementsByTagName('*').length })
            }))
          }
        }
        r.__aaProbe = true
        return r
      }
      const mo = new MutationObserver(records => {
        w.mutationBatches++
        for (const r of records) {
          if (r.type === 'characterData') w.textChanges++
          else { w.added += r.addedNodes.length; w.removed += r.removedNodes.length }
        }
      })
      const observe = () => mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
      if (document.documentElement) observe(); else addEventListener('DOMContentLoaded', observe)
      Object.defineProperty(window, 'aaRenderer', { configurable: true, get: () => current, set: v => { current = wrap(v) } })
      setInterval(() => {
        const r = n => Math.round(n * 10) / 10
        post({ type: 'window', frames: w.frames, dropped: w.dropped, maxGap: r(w.maxGap), gaps50: w.gaps50, gaps100: w.gaps100,
               recv: w.recv, recvAvg: w.recv ? r(w.recvMs / w.recv) : 0, recvMax: r(w.recvMax),
               paintAvg: w.paints ? r(w.paintMs / w.paints) : 0, paintMax: r(w.paintMax),
               added: w.added, removed: w.removed, textChanges: w.textChanges, mutationBatches: w.mutationBatches,
               dom: document.getElementsByTagName('*').length, heightK: Math.round(document.documentElement.scrollHeight / 1000),
               jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null })
        w = fresh()
      }, 5000)
    })();
    """.trimIndent()
}
