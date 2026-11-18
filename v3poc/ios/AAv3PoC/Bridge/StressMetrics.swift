import Darwin
import Foundation
import QuartzCore
import UIKit
import WebKit

/// Measurements for the stress runs (on when `AA_POC_STRESS` or `AA_POC_METRICS=1` is set). Every 5 s one line
/// `[stress] {"k":"native",…}` with what the bridge sent and how the main thread kept up; the renderer probe (an injected
/// WKUserScript, the renderer itself is untouched) reports `[stress] {"k":"web",…}` on the same clock.
@MainActor
final class StressMetrics {
    static let shared = StressMetrics()
    static let enabled = StressConfig.current != nil || ProcessInfo.processInfo.environment["AA_POC_METRICS"] == "1"

    private let start = Date()
    private var window = Window()
    private var inflight = 0
    private var link: CADisplayLink?
    private var lastFrame: CFTimeInterval = 0
    private var timer: Timer?
    private weak var webView: WKWebView?
    private var webPID: Int32 = 0
    private var snapshotSentAt: [Int: CFTimeInterval] = [:]
    private var snapshotCounter = 0

    private struct Window {
        var flushes = 0, events = 0, messageEvents = 0, bytes = 0, maxBytes = 0, maxEvents = 0
        var encodeMs = 0.0, encodeMax = 0.0
        var evals = 0, evalMs = 0.0, evalMax = 0.0, inflightMax = 0
        var frames = 0, dropped = 0, maxGap = 0.0
        var batchMax = 0
        var coalesced = 0
    }

    var t: Int { Int(Date().timeIntervalSince(start)) }

    func attach(_ webView: WKWebView) {
        guard Self.enabled else { return }
        self.webView = webView
        let link = CADisplayLink(target: Ticker { [weak self] in self?.frame($0) }, selector: #selector(Ticker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.report() }
        }
    }

    private func frame(_ link: CADisplayLink) {
        let now = link.timestamp
        defer { lastFrame = now }
        guard lastFrame > 0 else { return }
        let gap = (now - lastFrame) * 1000
        let expected = (link.targetTimestamp - link.timestamp) * 1000
        window.frames += 1
        if gap > expected * 1.5 { window.dropped += max(1, Int((gap / max(expected, 1)).rounded()) - 1) }
        window.maxGap = max(window.maxGap, gap)
    }

    // MARK: UI positions for the interaction test

    private var ui: [String: JSON] = [:]

    /// Where a control is (normalized to the screen), or nil when hidden: `<AA_POC_LOG_PATH>.ui.json`.
    func uiFrame(_ name: String, _ frame: CGRect?) {
        guard Self.enabled, let path = ProcessInfo.processInfo.environment["AA_POC_LOG_PATH"] else { return }
        let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen.bounds }.first ?? CGRect(x: 0, y: 0, width: 402, height: 874)
        ui[name] = frame.map { [.number($0.midX / screen.width), .number($0.midY / screen.height)] } ?? .null
        try? Data(JSON.object(ui).encodedString().utf8).write(to: URL(fileURLWithPath: path + ".ui.json"))
    }

    // MARK: Bridge

    func batch(length: Int) { window.batchMax = max(window.batchMax, length) }

    /// A waiting event was replaced by a newer value of the same item before it was sent.
    func coalesced() { window.coalesced += 1 }

    func snapshotPrepared(_ prepared: PreparedSnapshot) {
        guard Self.enabled else { return }
        log(["k": "snapshotPrepared", "full": true, "items": .number(Double(prepared.metrics.messageEvents)),
             "prepareMs": .number(prepared.prepareMs.rounded1), "bytes": .number(Double(prepared.script.utf8.count))])
    }

    /// A snapshot of the session the renderer already shows went out as this many watch events (0: identical).
    func snapshotDelta(events: Int, ms: Double) {
        guard Self.enabled else { return }
        log(["k": "snapshotPrepared", "full": false, "deltaEvents": .number(Double(events)), "skipped": .bool(events == 0),
             "prepareMs": .number(ms.rounded1)])
    }

    /// One `evaluateJavaScript` with this many watch events; returns the completion to call when it comes back.
    func willEvaluate(type: String, events: Int, messageEvents: Int, bytes: Int, encodeMs: Double, isSnapshot: Bool) -> () -> Void {
        guard Self.enabled else { return {} }
        window.flushes += 1
        window.events += events
        window.messageEvents += messageEvents
        window.bytes += bytes
        window.maxBytes = max(window.maxBytes, bytes)
        window.maxEvents = max(window.maxEvents, events)
        window.encodeMs += encodeMs
        window.encodeMax = max(window.encodeMax, encodeMs)
        inflight += 1
        window.inflightMax = max(window.inflightMax, inflight)
        let sent = CACurrentMediaTime()
        if isSnapshot {
            log(["k": "snapshotSent", "bytes": .number(Double(bytes)), "encodeMs": .number(encodeMs.rounded1)])
        }
        return { [weak self] in
            guard let self else { return }
            let ms = (CACurrentMediaTime() - sent) * 1000
            self.inflight -= 1
            self.window.evals += 1
            self.window.evalMs += ms
            self.window.evalMax = max(self.window.evalMax, ms)
            if isSnapshot { self.log(["k": "snapshotEval", "ms": .number(ms.rounded1), "bytes": .number(Double(bytes))]) }
        }
    }

    // MARK: Events

    func event(_ what: String, _ extra: [String: JSON] = [:]) {
        guard Self.enabled else { return }
        var fields = extra
        fields["k"] = "event"
        fields["what"] = .string(what)
        log(fields)
    }

    func renderer(_ body: JSON) {
        guard Self.enabled, case var .object(fields) = body else { return }
        fields["k"] = .string(fields["type"]?.string == "window" ? "web" : fields["type"]?.string ?? "web")
        fields["type"] = nil
        log(fields)
    }

    /// Diagnostics: every scroll view and touch-delaying recognizer inside the web view.
    func dumpTouchDelays() {
        guard Self.enabled, let webView else { return }
        func walk(_ view: UIView) {
            if let scroll = view as? UIScrollView {
                log(["k": "scrollView", "class": .string(String(describing: type(of: scroll))), "delaysContentTouches": .bool(scroll.delaysContentTouches),
                     "frame": .string(NSCoder.string(for: scroll.frame))])
            }
            for g in view.gestureRecognizers ?? [] where g.delaysTouchesBegan && g.isEnabled {
                log(["k": "delayingRecognizer", "class": .string(String(describing: type(of: g))), "view": .string(String(describing: type(of: view)))])
            }
            view.subviews.forEach(walk)
        }
        walk(webView)
    }

    func noteWebProcess() {
        guard Self.enabled, let webView else { return }
        // Private, diagnostics only: lets the host sample the WebContent process's memory.
        let pid = (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
        if pid != webPID {
            webPID = pid
            log(["k": "wcp", "pid": .number(Double(pid)), "app": .number(Double(getpid()))])
        }
    }

    private func report() {
        noteWebProcess()
        let w = window
        window = Window()
        let avg = { (total: Double, count: Int) in count > 0 ? (total / Double(count)).rounded1 : 0 }
        log(["k": "native",
             "flushes": .number(Double(w.flushes)), "events": .number(Double(w.events)), "msgEvents": .number(Double(w.messageEvents)),
             "kb": .number((Double(w.bytes) / 1024).rounded1), "maxKB": .number((Double(w.maxBytes) / 1024).rounded1),
             "maxEventsPerFlush": .number(Double(w.maxEvents)), "batchMax": .number(Double(w.batchMax)),
             "coalesced": .number(Double(w.coalesced)),
             "encodeAvg": .number(avg(w.encodeMs, w.flushes)), "encodeMax": .number(w.encodeMax.rounded1),
             "evalAvg": .number(avg(w.evalMs, w.evals)), "evalMax": .number(w.evalMax.rounded1),
             "inflightMax": .number(Double(w.inflightMax)), "inflightNow": .number(Double(inflight)),
             "uiFrames": .number(Double(w.frames)), "uiDropped": .number(Double(w.dropped)), "uiMaxGap": .number(w.maxGap.rounded1),
             "appMB": .number(Self.footprintMB().rounded1)])
    }

    func log(_ fields: [String: JSON]) {
        var fields = fields
        fields["t"] = .number(Date().timeIntervalSince(start).rounded1)
        fields["wall"] = .number(Date().timeIntervalSince1970.rounded1)
        LaunchClock.log("[stress] " + JSON.object(fields).encodedString())
    }

    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }

    /// Measures the renderer from inside the page without changing it: rAF gaps (dropped frames, longest stall),
    /// time spent in `aaRenderer.receive`, time from receive to the second following frame (≈ painted), DOM size.
    static let probeScript = """
    (() => {
      const post = m => { try { window.webkit.messageHandlers.aaStress.postMessage(m) } catch {} }
      const fresh = () => ({ frames: 0, dropped: 0, maxGap: 0, gaps50: 0, gaps100: 0, recv: 0, recvMs: 0, recvMax: 0, recvChars: 0,
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
      // How much of the DOM each update rewrites: appended nodes only (incremental) or whole subtrees replaced.
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
    """
}

private extension Double {
    var rounded1: Double { (self * 10).rounded() / 10 }
}

private final class Ticker: NSObject {
    let action: (CADisplayLink) -> Void
    init(_ action: @escaping (CADisplayLink) -> Void) { self.action = action }
    @objc func tick(_ link: CADisplayLink) { action(link) }
}
