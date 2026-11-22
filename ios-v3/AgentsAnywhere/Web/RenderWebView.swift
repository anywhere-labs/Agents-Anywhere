import AAClientCore
import SwiftUI
import UIKit
import WebKit

/// The WebKit side of `aa.render/2`: owns the outbox, flushes it once per frame, parses what the page posts and
/// replays state after the page reloads. Screen models own one and hand it to `RenderWebView`.
@MainActor
final class RenderBridge: NSObject {
    private var outbox = BridgeOutbox()
    private var flushScheduled = false
    private(set) weak var webView: WKWebView?
    /// Messages from the page (`ready` included; state should be (re)sent from there).
    var onMessage: ((BridgeIn) -> Void)?

    var isReady: Bool { outbox.isReady }

    /// Queue a message; it goes out with the next frame once the page is ready.
    func send(_ message: JSONValue) {
        outbox.enqueue(message)
        scheduleFlush()
    }

    func send(_ messages: [JSONValue]) {
        for message in messages { outbox.enqueue(message) }
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !flushScheduled, outbox.isReady else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(16)) { [weak self] in
            self?.flush()
        }
    }

    private func flush() {
        flushScheduled = false
        guard let webView, let script = outbox.drainScript() else { return }
        #if DEBUG
        if ProcessInfo.processInfo.environment["AA_DEBUG_BRIDGE"] != nil { print("[aa.render] → \(script.prefix(300))") }
        #endif
        webView.evaluateJavaScript(script) { _, error in
            if let error { print("[aa.render] evaluate failed: \(error.localizedDescription)") }
        }
    }

    fileprivate func attach(_ webView: WKWebView) {
        self.webView = webView
    }

    fileprivate func pageReset() {
        outbox.reset()
    }

    fileprivate func receive(_ body: Any) {
        guard let message = BridgeIn.parse(body) else { return }
        if case .ready = message {
            // Whatever was queued before is superseded by the state the owner sends on `ready`.
            outbox.reset()
            outbox.markReady()
        }
        onMessage?(message)
        scheduleFlush()
    }

    /// The render bundle: the web-v3 build copied in at build time, else the bundled placeholder.
    static var bundleURL: URL? {
        Bundle.main.url(forResource: "aa-render", withExtension: "html")
            ?? Bundle.main.url(forResource: "aa-render-placeholder", withExtension: "html")
    }
}

/// WebKit holds its script message handlers strongly; this breaks the cycle.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var bridge: RenderBridge?
    init(_ bridge: RenderBridge) { self.bridge = bridge }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        MainActor.assumeIsolated { bridge?.receive(body) }
    }
}

/// Hosts the WKWebView. The web view is created only once this view is in a window (so WebKit's touch handling is
/// set up against a real window), fills the screen, and draws under the native glass controls; the page pads its
/// content by the `theme.insets` the owner sends. No gesture recognizers are added here or on any ancestor.
final class RenderHostView: UIView, WKNavigationDelegate, WKUIDelegate {
    let bridge: RenderBridge
    private var webView: WKWebView?
    var onOpenExternal: ((URL) -> Void)?
    /// The safe area SwiftUI gives this edge-to-edge view: bars, home indicator and `safeAreaInset` controls.
    var onSafeAreaChange: ((UIEdgeInsets) -> Void)?

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        onSafeAreaChange?(safeAreaInsets)
    }

    init(bridge: RenderBridge) {
        self.bridge = bridge
        super.init(frame: .zero)
        backgroundColor = .systemBackground
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, webView == nil else { return }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(WeakScriptHandler(bridge), name: "aa")
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.dataDetectorTypes = []
        let webView = WKWebView(frame: bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsLinkPreview = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        addSubview(webView)
        self.webView = webView
        bridge.attach(webView)
        load()
    }

    private func load() {
        guard let webView, let url = RenderBridge.bundleURL else { return }
        bridge.pageReset()
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // The page never navigates away: links go to the system.
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        if url?.isFileURL == true || url?.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        if let url { onOpenExternal?(url) }
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page is gone: queue until it says `ready` again, then the owner replays state.
        load()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { onOpenExternal?(url) }
        return nil
    }
}

struct RenderWebView: UIViewRepresentable {
    let bridge: RenderBridge
    var onSafeArea: ((UIEdgeInsets) -> Void)?
    @Environment(\.openURL) private var openURL

    func makeUIView(context: Context) -> RenderHostView {
        let view = RenderHostView(bridge: bridge)
        view.onOpenExternal = { url in openURL(url) }
        view.onSafeAreaChange = onSafeArea
        return view
    }

    func updateUIView(_ view: RenderHostView, context: Context) {}
}

/// The `theme` message for the current environment and the space native controls cover.
struct RenderTheme: Equatable {
    var dark: Bool
    var insets: EdgeInsets
    var fontScale: Double
    var reduceMotion: Bool
    var highContrast: Bool

    var message: JSONValue {
        BridgeOut.theme(
            dark: dark,
            insets: .init(top: insets.top, bottom: insets.bottom, left: insets.leading, right: insets.trailing),
            fontScale: fontScale, reduceMotion: reduceMotion, highContrast: highContrast)
    }
}

extension DynamicTypeSize {
    /// Rough text scale relative to `.large`, for the page's base font size.
    var scale: Double {
        switch self {
        case .xSmall: 0.82
        case .small: 0.88
        case .medium: 0.94
        case .large: 1
        case .xLarge: 1.12
        case .xxLarge: 1.24
        case .xxxLarge: 1.35
        case .accessibility1: 1.6
        case .accessibility2: 1.9
        case .accessibility3: 2.2
        case .accessibility4: 2.5
        case .accessibility5: 2.8
        @unknown default: 1
        }
    }
}

/// The WebView drawn edge to edge (under the navigation bar and the native bottom controls), with the `theme` for
/// the current environment and the space covered by native chrome: the safe area UIKit reports for the host view
/// (bars, home indicator) plus `extraBottom`, the height of the native controls placed with `safeAreaInset`.
struct RenderSurface: View {
    let bridge: RenderBridge
    var extraBottom: CGFloat = 0
    let onTheme: (RenderTheme) -> Void
    @State private var safeArea: UIEdgeInsets?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        RenderWebView(bridge: bridge) { insets in safeArea = insets }
            .ignoresSafeArea(.container)
            .onChange(of: theme, initial: true) { _, theme in
                if let theme { onTheme(theme) }
            }
    }

    private var theme: RenderTheme? {
        guard let safeArea else { return nil }
        let insets = EdgeInsets(top: safeArea.top, leading: safeArea.left, bottom: safeArea.bottom + extraBottom, trailing: safeArea.right)
        return RenderTheme(
            dark: colorScheme == .dark, insets: insets, fontScale: typeSize.scale, reduceMotion: reduceMotion,
            highContrast: contrast == .increased)
    }
}
