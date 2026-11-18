import Observation
import QuartzCore
import UIKit
import WebKit

/// `aa.render/1`: the one long-lived WKWebView and the message pipe to the renderer inside it.
/// Native → renderer: `window.aaRenderer.receive(message)`. Renderer → native: `webkit.messageHandlers.aa`.
@MainActor @Observable
final class RendererBridge {
    enum Phase: Equatable {
        case loading
        case ready(renderer: String)
        /// The bundle has no Renderer/renderer.html.
        case missing
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    /// From the renderer's `scroll` message.
    private(set) var atEnd = true
    /// Whether the 到底部 pill is shown, with hysteresis so it does not flicker while the thread streams and follows the
    /// end: it appears only once the reader is more than `EndButton.showDistance` above the end (and the renderer says
    /// it is not at the end), and goes away only back at the end (the renderer says so, or within `hideDistance`).
    private(set) var showsEndButton = false
    @ObservationIgnored private var scrollObservations: [NSKeyValueObservation] = []

    enum EndButton {
        static let showDistance: CGFloat = 160
        static let hideDistance: CGFloat = 24
    }
    /// Launch → `ready`, in ms.
    private(set) var readyAfter: Int?

    /// Created by `makeWebView()` once the hosting view is in a window, never earlier (see there).
    @ObservationIgnored private(set) var webView: WKWebView?
    @ObservationIgnored private let delegate = RendererWebDelegate()
    @ObservationIgnored private var displayLink: CADisplayLink?
    @ObservationIgnored private var lastViewport: JSON?
    @ObservationIgnored private var lastAppearance: JSON?
    @ObservationIgnored private var loadStartedAt: Date?

    // Outbox. Watch events wait here, coalesced (one slot per item id, one for control, one for session), while the
    // renderer is still busy with the previous `evaluateJavaScript`: at most one is in flight, so a slow page gets fewer,
    // newer updates instead of a growing queue of stale ones. Other host messages keep their order; viewport and
    // appearance keep only the latest.
    @ObservationIgnored private var events: [JSON] = []
    @ObservationIgnored private var eventSlots: [String: Int] = [:]
    @ObservationIgnored private var others: [JSON] = []
    @ObservationIgnored private var inFlight = false
    /// A snapshot (or its delta) prepared off the main thread, sent before anything else.
    @ObservationIgnored private var preparedSnapshot: PreparedSnapshot?
    /// Bumped by every `show`: a preparation that finishes for an older one is dropped.
    @ObservationIgnored private var snapshotGeneration = 0
    @ObservationIgnored private var preparing: Int?
    /// Bumped by every page load: completions of evaluations from the old page are ignored.
    @ObservationIgnored private var pageEpoch = 0
    /// The session whose full snapshot the renderer has been given (nil after a reload, and while a new one is
    /// being prepared): only then can a later snapshot of it go out as a delta.
    @ObservationIgnored private var deliveredSessionID: String?
    /// The strongest `memoryPressure` sent to this page; sent again when the page reloads.
    @ObservationIgnored private(set) var pressure: String?

    /// The snapshot of the session on screen; sent again whenever the renderer (re)becomes ready.
    @ObservationIgnored var currentSnapshot: () -> JSON? = { nil }
    /// Renderer messages other than `ready` / `scroll`.
    @ObservationIgnored var onMessage: (JSON) -> Void = { _ in }

    init() {
        // Diagnostics: the composer owns keyboard avoidance; the web view's own insets must stay zero.
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.logInsets("keyboard did show") }
        }
    }

    /// The one WKWebView, created on first use and kept for the app's lifetime.
    ///
    /// Only call this when the hosting view is in a window. UIKit ties every gesture recognizer to the delayed-touch
    /// dispatcher of the app and window that exist when it is created; a WKWebView made before the scene's window (in
    /// `App.init`, as this PoC first did) brings dozens of WebKit recognizers registered without one, and the first of
    /// them to delay a touch aborts the app in `-[UIGestureRecognizer _delayTouchesForEvent:inPhase:]` (inserting nil).
    /// For the same reason nothing here changes `delaysContentTouches` or other touch-delay flags later.
    func makeWebView() -> WKWebView {
        if let webView { return webView }
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(RendererSchemeHandler(), forURLScheme: RendererSchemeHandler.scheme)
        configuration.dataDetectorTypes = []
        configuration.suppressesIncrementalRendering = false
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        let controller = configuration.userContentController
        controller.add(delegate, name: "aa")
        controller.add(delegate, name: "aaLog")
        if StressMetrics.enabled {
            controller.add(delegate, name: "aaStress")
            controller.addUserScript(WKUserScript(source: StressMetrics.probeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        controller.addUserScript(WKUserScript(source: Self.consoleHook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: Self.viewportGuard, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        if DebugLaunch.layoutCheck {
            controller.addUserScript(WKUserScript(source: Self.scrollProbe, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 800), configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.underPageBackgroundColor = .systemBackground
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isInspectable = true
        let scrollView = webView.scrollView
        scrollView.backgroundColor = .clear
        // The renderer pads its content by `viewport`; UIKit must not add the safe area or the keyboard on top.
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        scrollView.keyboardDismissMode = .onDrag
        scrollView.bouncesZoom = false
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 1
        scrollView.topEdgeEffect.style = .soft
        // Product decision: no blur or fade behind the composer and approval dock, only their own glass.
        scrollView.bottomEdgeEffect.isHidden = true
        if let lastViewport, let top = lastViewport["top"]?.double, let bottom = lastViewport["bottom"]?.double {
            scrollView.verticalScrollIndicatorInsets = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
        }

        webView.navigationDelegate = delegate
        webView.uiDelegate = delegate
        delegate.bridge = self
        self.webView = webView
        scrollObservations = [
            scrollView.observe(\.contentOffset) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateEndButton() } },
            scrollView.observe(\.contentSize) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateEndButton() } },
        ]
        StressMetrics.shared.attach(webView)
        LaunchClock.mark("WKWebView created (window present)")
        if DebugLaunch.layoutCheck {
            LaunchClock.log("[scroll] idiom=\(UIDevice.current.userInterfaceIdiom.rawValue) web pan allowedScrollTypesMask=\(scrollView.panGestureRecognizer.allowedScrollTypesMask.rawValue) plain UIScrollView=\(UIScrollView().panGestureRecognizer.allowedScrollTypesMask.rawValue)")
        }
        load()
        return webView
    }

    func load() {
        guard RendererSchemeHandler.rendererFile.map({ FileManager.default.fileExists(atPath: $0.path) }) == true else {
            phase = .missing
            LaunchClock.log("renderer.html is not in the app bundle (expected AAv3PoC/Renderer/renderer.html)")
            return
        }
        phase = .loading
        atEnd = true
        showsEndButton = false
        pageEpoch += 1
        inFlight = false
        preparing = nil
        preparedSnapshot = nil
        deliveredSessionID = nil
        loadStartedAt = Date()
        LaunchClock.mark("load \(RendererSchemeHandler.rendererURL.absoluteString)")
        webView?.load(URLRequest(url: RendererSchemeHandler.rendererURL))
    }

    var isReady: Bool { if case .ready = phase { true } else { false } }

    // MARK: Native → renderer

    /// A watch event for the session on screen. Coalesced by id until the renderer has taken the previous batch.
    func enqueue(_ event: JSON) {
        guard isReady else { return } // The snapshot sent on `ready` already contains it.
        let key: String? = switch event["type"]?.string {
        case "message": event["message"]?["id"]?.string.map { "m:" + $0 }
        case "control": "control"
        case "session": "session"
        default: nil
        }
        if let key, let slot = eventSlots[key] {
            events[slot] = event
            StressMetrics.shared.coalesced()
        } else {
            if let key { eventSlots[key] = events.count }
            events.append(event)
        }
        StressMetrics.shared.batch(length: events.count)
        schedulePump()
    }

    /// Opening a session = sending its snapshot.
    ///
    /// `rendererHas`: the cached state of this session as it was before this snapshot, which is what the renderer has
    /// (delivered or waiting in the outbox) when it last received this session. In that case only what differs goes out,
    /// as ordinary watch events merged into the outbox, and nothing at all when the snapshot is identical (switching
    /// back to a session shows the cache first, then the watch snapshot arrives). Otherwise the full snapshot replaces
    /// everything waiting; its JSON is encoded off the main thread and later events wait behind it.
    func show(snapshot: JSON, rendererHas previous: SessionState? = nil) {
        let sessionID = snapshot["session"]?["id"]?.string
        guard isReady else { return } // `ready` sends the current snapshot.
        if let previous, sessionID != nil, deliveredSessionID == sessionID {
            let start = CACurrentMediaTime()
            if let delta = PreparedSnapshot.delta(snapshot, from: previous) {
                StressMetrics.shared.snapshotDelta(events: delta.count, ms: (CACurrentMediaTime() - start) * 1000)
                for event in delta { enqueue(event) }
                return
            }
        }
        events.removeAll()
        eventSlots.removeAll()
        snapshotGeneration += 1
        let generation = snapshotGeneration
        // Until this snapshot is evaluated the renderer's content is not a base for deltas.
        deliveredSessionID = nil
        preparedSnapshot = nil
        preparing = generation
        let epoch = pageEpoch
        Task.detached(priority: .userInitiated) {
            let prepared = PreparedSnapshot.make(snapshot)
            await MainActor.run { [weak self] in
                guard let self else { return }
                if self.preparing == generation { self.preparing = nil }
                guard generation == self.snapshotGeneration, epoch == self.pageEpoch else { self.schedulePump(); return }
                StressMetrics.shared.snapshotPrepared(prepared)
                self.preparedSnapshot = prepared
                self.schedulePump()
            }
        }
    }

    /// The OS is short of memory: the renderer drops off-screen DOM and older items (`aa.render/1` memoryPressure).
    func memoryPressure(_ level: String) {
        if pressure != "critical" { pressure = level }
        StressMetrics.shared.event("memoryPressure", ["level": .string(level)])
        sendOther(["type": "memoryPressure", "level": .string(level)])
    }

    func setViewport(top: Double, bottom: Double) {
        let message: JSON = ["type": "viewport", "top": .number(top.rounded()), "bottom": .number(bottom.rounded())]
        guard message != lastViewport else { return }
        lastViewport = message
        webView?.scrollView.verticalScrollIndicatorInsets = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
        sendOther(message)
    }

    /// `textScale`: the body size at the current Dynamic Type setting divided by the body size at the default
    /// (Large), so 1.0 by default. `account` lets the renderer show 「你」 when `control.answered[].by` is this name.
    func setAppearance(dark: Bool, textScale: Double, reduceMotion: Bool, locale: String, accountName: String) {
        let message: JSON = ["type": "appearance", "scheme": .string(dark ? "dark" : "light"), "textScale": .number(textScale),
                             "reduceMotion": .bool(reduceMotion), "locale": .string(locale),
                             "account": ["name": .string(accountName)]]
        guard message != lastAppearance else { return }
        lastAppearance = message
        sendOther(message)
    }

    /// Distance from the bottom of the visible thread to the end of the document, in points.
    private var distanceToEnd: CGFloat {
        guard let scrollView = webView?.scrollView else { return 0 }
        return scrollView.contentSize.height + scrollView.adjustedContentInset.bottom
            - scrollView.contentOffset.y - scrollView.bounds.height
    }

    @ObservationIgnored private var loggedOffset: CGFloat?

    private func updateEndButton() {
        if DebugLaunch.layoutCheck, let scrollView = webView?.scrollView,
           abs(scrollView.contentOffset.y - (loggedOffset ?? .infinity)) >= 40 || loggedOffset == nil {
            loggedOffset = scrollView.contentOffset.y
            LaunchClock.log(String(format: "[scroll] y=%.0f height=%.0f", scrollView.contentOffset.y, scrollView.contentSize.height))
        }
        let distance = distanceToEnd
        let next = showsEndButton
            ? !(atEnd || distance <= EndButton.hideDistance)
            : (isReady && !atEnd && distance > EndButton.showDistance)
        if next != showsEndButton {
            showsEndButton = next
            if DebugLaunch.layoutCheck { LaunchClock.log("[pill] shown=\(next ? 1 : 0)") }
        }
    }

    func scrollToEnd(animated: Bool = true) {
        sendOther(["type": "scrollToEnd", "animated": .bool(animated)])
    }

    /// Debug (`AA_POC_BACKDROP`): a fixed layer over the whole page, for contrast checks of the native chrome.
    func debugBackdrop(_ kind: String) {
        let css: String = switch kind {
        case "white": "background:#fff"
        case "black": "background:#000"
        case "stripes": "background:repeating-linear-gradient(0deg,#000 0 10px,#fff 10px 20px)"
        default: "background:linear-gradient(160deg,#0b1d51 0%,#f4b400 35%,#ffffff 50%,#1b5e20 65%,#000 100%)"
        }
        webView?.evaluateJavaScript("""
        (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;\(css)'; document.documentElement.appendChild(d); })(); void 0
        """)
    }

    /// Debug (`AA_POC_SCROLL_UP`): move the document up like a reader's drag would.
    func scrollUp(by points: Double) {
        guard let scrollView = webView?.scrollView else { return }
        let y = max(-scrollView.adjustedContentInset.top, scrollView.contentOffset.y - points)
        scrollView.setContentOffset(CGPoint(x: 0, y: y), animated: true)
    }

    func older(messages: [JSON], hasMore: Bool) {
        sendOther(["type": "older", "messages": .array(messages), "has_more": .bool(hasMore)])
    }

    private func sendOther(_ message: JSON) {
        guard isReady else { return }
        let type = message["type"]?.string
        if type == "viewport" || type == "appearance" { others.removeAll { $0["type"]?.string == type } }
        others.append(message)
        schedulePump()
    }

    private func schedulePump() {
        if displayLink == nil {
            let link = CADisplayLink(target: DisplayLinkTarget { [weak self] in self?.pump() }, selector: #selector(DisplayLinkTarget.tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
        displayLink?.isPaused = false
    }

    /// Once per display frame: if nothing is in flight, send what is waiting as one `evaluateJavaScript`.
    private func pump() {
        guard isReady, !inFlight else { return }
        if let prepared = preparedSnapshot {
            preparedSnapshot = nil
            deliveredSessionID = prepared.sessionID
            evaluate(prepared.script, metrics: prepared.metrics)
            return
        }
        guard preparing == nil else { return } // a snapshot is being prepared: newer events wait behind it
        guard !events.isEmpty || !others.isEmpty else { displayLink?.isPaused = true; return }
        let encodeStart = CACurrentMediaTime()
        var parts: [String] = []
        var metrics = EvaluationMetrics()
        if !events.isEmpty {
            parts.append("r.receive(" + JSON.object(["type": "watch", "events": .array(events)]).encodedString() + ")")
            metrics.events = events.count
            metrics.messageEvents = events.filter { $0["type"]?.string == "message" }.count
            events.removeAll()
            eventSlots.removeAll()
        }
        for message in others { parts.append("r.receive(" + message.encodedString() + ")") }
        others.removeAll()
        let script = "(() => { const r = window.aaRenderer; " + parts.joined(separator: "; ") + " })(); void 0"
        metrics.encodeMs = (CACurrentMediaTime() - encodeStart) * 1000
        evaluate(script, metrics: metrics)
    }

    private func evaluate(_ script: String, metrics: EvaluationMetrics) {
        guard let webView else { return }
        inFlight = true
        let epoch = pageEpoch
        let done = StressMetrics.shared.willEvaluate(type: "batch", events: metrics.events, messageEvents: metrics.messageEvents,
                                                     bytes: script.utf8.count, encodeMs: metrics.encodeMs, isSnapshot: metrics.isSnapshot)
        webView.evaluateJavaScript(script) { [weak self] _, error in
            done()
            if let error { LaunchClock.log("receive failed: \(error.localizedDescription)") }
            guard let self, epoch == self.pageEpoch else { return }
            self.inFlight = false
            self.schedulePump()
        }
    }

    // MARK: Renderer → native

    fileprivate func receive(_ body: JSON) {
        switch body["type"]?.string {
        case "ready":
            let renderer = body["renderer"]?.string ?? "?"
            readyAfter = LaunchClock.milliseconds()
            let sinceLoad = loadStartedAt.map { LaunchClock.milliseconds(since: $0) } ?? -1
            LaunchClock.mark("renderer ready (\(renderer), protocol \(body["protocol"]?.string ?? "?"), \(sinceLoad)ms after load start)")
            phase = .ready(renderer: renderer)
            StressMetrics.shared.event("ready", ["sinceLoadMs": .number(Double(sinceLoad))])
            StressMetrics.shared.noteWebProcess()
            Task { try? await Task.sleep(for: .seconds(2)); StressMetrics.shared.dumpTouchDelays() }
            events.removeAll()
            eventSlots.removeAll()
            others.removeAll()
            deliveredSessionID = nil
            sendOther(["type": "chrome", "approvals": "host"])
            if let lastAppearance { sendOther(lastAppearance) }
            if let lastViewport { sendOther(lastViewport) }
            if let pressure { sendOther(["type": "memoryPressure", "level": .string(pressure)]) }
            if let snapshot = currentSnapshot() { show(snapshot: snapshot) }
        case "scroll":
            atEnd = body["atEnd"]?.bool ?? true
            updateEndButton()
            StressMetrics.shared.event("scroll", ["atEnd": .bool(atEnd), "atTop": body["atTop"] ?? .null])
        default:
            onMessage(body)
        }
    }

    fileprivate func didFinishNavigation() {
        LaunchClock.mark("didFinish navigation")
        disablePinch()
        Task { @MainActor [weak self] in
            // A page without the bridge never says `ready`.
            try? await Task.sleep(for: .seconds(5))
            guard let self, self.phase == .loading else { return }
            self.phase = .failed("渲染器加载完成，但 5 秒内没有发送 ready。")
        }
    }

    fileprivate func didFail(_ error: Error) {
        phase = .failed(error.localizedDescription)
        LaunchClock.log("navigation failed: \(error.localizedDescription)")
    }

    fileprivate func contentProcessTerminated() {
        LaunchClock.log("web content process terminated; reloading")
        StressMetrics.shared.event("webContentTerminated")
        // On a device a terminated WebContent process almost always means the system reclaimed its memory: the reloaded
        // page starts with the smaller windows of `memoryPressure: warning` (renderer levels reset on reload).
        if pressure == nil { pressure = "warning" }
        load()
    }

    private func logInsets(_ label: String) {
        guard let scrollView = webView?.scrollView else { return }
        LaunchClock.log("\(label): contentInset \(scrollView.contentInset) adjusted \(scrollView.adjustedContentInset) offset \(scrollView.contentOffset.y) viewport \(lastViewport?.encodedString() ?? "-")")
    }

    private func disablePinch() {
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
    }

    // MARK: Injected scripts

    /// Debug (`AA_POC_LAYOUT_CHECK=1`): log sideways scrolling inside the document (code blocks, tables) as `[hscroll]`,
    /// and every `wheel` event's deltas as `[wheel]` (throttled), so UI tests can check pointer scrolling end to end.
    private static let scrollProbe = """
    (() => {
      const post = m => { try { window.webkit.messageHandlers.aaLog.postMessage('log: ' + m) } catch {} };
      const last = new WeakMap();
      document.addEventListener('scroll', e => {
        const el = e.target; if (!(el instanceof Element)) return;
        const x = Math.round(el.scrollLeft), prev = last.get(el) ?? 0;
        if (Math.abs(x - prev) < 40) return; last.set(el, x);
        post('[hscroll] ' + el.tagName.toLowerCase() + ' left=' + x + ' of=' + Math.round(el.scrollWidth - el.clientWidth));
      }, { capture: true, passive: true });
      let wheelAt = 0;
      addEventListener('wheel', e => {
        const now = performance.now(); if (now - wheelAt < 250) return; wheelAt = now;
        post('[wheel] dx=' + Math.round(e.deltaX) + ' dy=' + Math.round(e.deltaY));
      }, { capture: true, passive: true });
    })();
    """

    private static let consoleHook = """
    (() => {
      const post = (level, args) => { try { window.webkit.messageHandlers.aaLog.postMessage(level + ': ' + args.map(a => {
        if (a instanceof Error) return a.stack || String(a); try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) } }).join(' ')) } catch {} };
      for (const level of ['error', 'warn']) { const original = console[level]; console[level] = (...args) => { post(level, args); original.apply(console, args) } }
      addEventListener('error', e => post('uncaught', [e.message + ' @' + e.filename + ':' + e.lineno]));
      addEventListener('unhandledrejection', e => post('unhandledrejection', [String(e.reason)]));
    })();
    """

    /// Fixed scale, no double-tap zoom. Only added when the renderer did not declare its own viewport.
    private static let viewportGuard = """
    if (!document.querySelector('meta[name=viewport]')) {
      const meta = document.createElement('meta'); meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
      document.head.appendChild(meta);
    }
    """
}

/// WebKit delegates, kept off the observable bridge.
final class RendererWebDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    weak var bridge: RendererBridge?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "aaStress" {
            StressMetrics.shared.renderer(JSON(any: message.body))
            return
        }
        if message.name == "aaLog" {
            LaunchClock.log("js \(message.body)")
            return
        }
        bridge?.receive(JSON(any: message.body))
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == RendererSchemeHandler.scheme, url.host == "renderer", action.navigationType != .linkActivated {
            return .allow
        }
        if action.targetFrame?.isMainFrame == false { return .allow } // subresource frames, if any
        // Never navigate away from the renderer: links open natively.
        bridge?.receive(["type": "open", "target": ["kind": "url", "url": .string(url.absoluteString)]])
        return .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { bridge?.didFinishNavigation() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { bridge?.didFail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { bridge?.didFail(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { bridge?.contentProcessTerminated() }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            bridge?.receive(["type": "open", "target": ["kind": "url", "url": .string(url.absoluteString)]])
        }
        return nil
    }
}

/// CADisplayLink retains its target; this keeps the bridge out of that cycle.
private final class DisplayLinkTarget: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func tick() { action() }
}

/// What one `evaluateJavaScript` carried, for the stress measurements.
nonisolated struct EvaluationMetrics: Sendable {
    var events = 0
    var messageEvents = 0
    var encodeMs = 0.0
    var isSnapshot = false
}

/// A full snapshot encoded off the main thread.
nonisolated struct PreparedSnapshot: Sendable {
    let script: String
    let sessionID: String?
    let prepareMs: Double
    let metrics: EvaluationMetrics

    static func make(_ snapshot: JSON) -> PreparedSnapshot {
        let start = CACurrentMediaTime()
        let script = "window.aaRenderer.receive(" + JSON.object(["type": "watch", "events": [snapshot]]).encodedString() + "); void 0"
        let ms = (CACurrentMediaTime() - start) * 1000
        var metrics = EvaluationMetrics()
        metrics.events = 1
        metrics.messageEvents = snapshot["messages"]?.array?.count ?? 0
        metrics.encodeMs = ms
        metrics.isSnapshot = true
        return PreparedSnapshot(script: script, sessionID: snapshot["session"]?["id"]?.string, prepareMs: ms, metrics: metrics)
    }

    /// Message / session / control events that turn `previous` into `snapshot`, or nil when that is not possible
    /// (an item the renderer has is gone: a rewind). Items older than what the renderer has are left to `loadOlder`.
    static func delta(_ snapshot: JSON, from previous: SessionState) -> [JSON]? {
        let messages = snapshot["messages"]?.array ?? []
        guard let oldFirst = previous.messages.first?["seq"]?.int else { return nil }
        let newFirst = messages.first?["seq"]?.int ?? Int.max
        var incoming: [String: JSON] = [:]
        for message in messages { if let id = message["id"]?.string { incoming[id] = message } }
        for old in previous.messages {
            guard let id = old["id"]?.string else { continue }
            if incoming[id] == nil, (old["seq"]?.int ?? 0) >= newFirst { return nil }
        }
        var events: [JSON] = []
        if let session = snapshot["session"], session != previous.session { events.append(["type": "session", "session": session]) }
        for message in messages where (message["seq"]?.int ?? 0) >= oldFirst {
            guard let id = message["id"]?.string else { continue }
            if previous.message(id) != message { events.append(["type": "message", "message": message]) }
        }
        if let control = snapshot["control"], control != previous.control { events.append(["type": "control", "control": control]) }
        return events
    }
}
