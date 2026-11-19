import SwiftUI
import UIKit
import WebKit

/// The conversation page, in UIKit. Its view holds, as siblings from back to front:
///
/// 1. the app's single WKWebView, edge to edge (created here once the view is in a window, see
///    `RendererBridge.makeWebView`);
/// 2. the SwiftUI chrome layer (`ConversationChrome`: dock, composer, pill, toasts, sheets) in a `ChromeLayerView`
///    that takes only the touches inside the chrome's controls.
///
/// The navigation bar (title, sidebar and session-menu buttons) belongs to the UINavigationController around this page
/// and is drawn above it, also as a sibling of this view. So no view that is an ancestor of the web view carries a
/// SwiftUI gesture recognizer, and a touch on the thread is seen by WebKit's recognizers alone.
final class ConversationViewController: UIViewController {
    let controller: SessionController
    var onMenu: () -> Void = {}

    private var bridge: RendererBridge { controller.bridge }
    private var webView: WKWebView?
    private let chromeLayer = ChromeLayerView()
    private var chrome: UIHostingController<ConversationChrome>!
    private var titleHost: UIHostingController<ConversationTitle>!
    private var bottomBarFrame: CGRect?

    init(controller: SessionController) {
        self.controller = controller
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        chrome = UIHostingController(rootView: ConversationChrome(controller: controller) { [weak self] regions in
            self?.chromeRegionsChanged(regions)
        })
        // The layer is placed between the navigation bar and the keyboard (or the home indicator) by constraints below;
        // SwiftUI adds no safe area or keyboard inset of its own.
        chrome.safeAreaRegions = []
        chrome.view.backgroundColor = .clear
        addChild(chrome)
        chromeLayer.translatesAutoresizingMaskIntoConstraints = false
        chrome.view.translatesAutoresizingMaskIntoConstraints = false
        chromeLayer.addSubview(chrome.view)
        view.addSubview(chromeLayer)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            chromeLayer.topAnchor.constraint(equalTo: guide.topAnchor),
            chromeLayer.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            chromeLayer.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
            chromeLayer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            chrome.view.topAnchor.constraint(equalTo: chromeLayer.topAnchor),
            chrome.view.leadingAnchor.constraint(equalTo: chromeLayer.leadingAnchor),
            chrome.view.trailingAnchor.constraint(equalTo: chromeLayer.trailingAnchor),
            chrome.view.bottomAnchor.constraint(equalTo: chromeLayer.bottomAnchor),
        ])
        chrome.didMove(toParent: self)

        configureNavigationItem()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _: UITraitCollection) in
            self.webView?.underPageBackgroundColor = .systemBackground
        }
        observeReadiness()
    }

    /// The first moment the view is in a window: only now may the web view (and its gesture recognizers) be created.
    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        attachWebView()
    }

    private func attachWebView() {
        guard webView == nil, view.window != nil else { return }
        let webView = bridge.makeWebView()
        webView.frame = view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.alpha = bridge.isReady ? 1 : 0
        view.insertSubview(webView, at: 0)
        self.webView = webView
        // The navigation bar's scroll edge effect (the soft blur under the glass bar) is drawn over the web view's own
        // UIScrollView. Top only: the bottom edge has no effect.
        setContentScrollView(webView.scrollView, for: .top)
        updateViewport()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateViewport()
    }

    // MARK: Viewport

    private func chromeRegionsChanged(_ regions: [String: CGRect]) {
        chromeLayer.regions = regions.filter { $0.key != ChromeRegion.bottomBar }.map(\.value)
        bottomBarFrame = regions[ChromeRegion.bottomBar]
        updateViewport()
        if DebugLaunch.layoutCheck { checkLayout(regions) }
    }

    /// `AA_POC_LAYOUT_CHECK=1`: on every layout of the chrome, log whether the 到底部 pill keeps 6 pt above the bar.
    private func checkLayout(_ regions: [String: CGRect]) {
        let bar = regions[ChromeRegion.bottomBar]
        StressMetrics.shared.uiFrame("bar", bar.map { chromeLayer.convert($0, to: nil) })
        guard let pill = regions["pill"], let bar else { return }
        let gap = bar.minY - pill.maxY
        let keyboard = view.keyboardLayoutGuide.layoutFrame.height > view.safeAreaInsets.bottom + 1
        LaunchClock.log(String(format: "[layout] pill.maxY=%.1f bar.minY=%.1f gap=%.1f dock=%d keyboard=%d %@",
                               pill.maxY, bar.minY, gap, regions["dock"] == nil ? 0 : 1, keyboard ? 1 : 0,
                               gap >= 5.5 ? "ok" : "OVERLAP"))
    }

    /// What covers the thread: status bar + navigation bar on top; dock / composer + home indicator or keyboard at the
    /// bottom. The renderer pads its document by these, so it scrolls under the glass.
    private func updateViewport() {
        guard isViewLoaded else { return }
        let top = view.safeAreaInsets.top
        let barTop = bottomBarFrame.map { chromeLayer.convert($0, to: view).minY } ?? chromeLayer.frame.maxY
        bridge.setViewport(top: top, bottom: max(0, view.bounds.maxY - barTop))
    }

    // MARK: Navigation bar

    private func configureNavigationItem() {
        titleHost = UIHostingController(rootView: ConversationTitle(controller: controller))
        titleHost.sizingOptions = [.intrinsicContentSize]
        titleHost.view.backgroundColor = .clear
        navigationItem.titleView = LeadingTitleView(content: titleHost.view)
        navigationItem.largeTitleDisplayMode = .never

        let menu = UIBarButtonItem(image: AppSymbolImage.named("sidebar.left", pointSize: 22), primaryAction: UIAction { [weak self] _ in
            self?.onMenu()
        })
        menu.accessibilityLabel = "打开侧栏"
        navigationItem.leftBarButtonItems = [menu]

        let session = UIBarButtonItem(image: AppSymbolImage.named("ellipsis", pointSize: 20), menu: UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.sessionMenuItems() ?? [])
            },
        ]))
        session.accessibilityLabel = "会话菜单"
        navigationItem.rightBarButtonItems = [session]
    }

    private func sessionMenuItems() -> [UIMenuElement] {
        var items: [UIMenuElement] = [
            UIAction(title: "会话详情", image: UIImage(systemName: "info.circle")) { [weak self] _ in
                self?.controller.showToast("演示：会话详情")
            },
            UIAction(title: "复制会话 ID", image: UIImage(systemName: "number")) { [weak self] _ in
                UIPasteboard.general.string = self?.controller.selectedID
                self?.controller.showToast("已复制")
            },
        ]
        if controller.isRunning {
            items.append(UIMenu(options: .displayInline, children: [
                UIAction(title: "停止", image: UIImage(systemName: "stop.circle"), attributes: .destructive) { [weak self] _ in
                    self?.controller.stop()
                },
            ]))
        }
        return items
    }

    // MARK: Renderer readiness

    private func observeReadiness() {
        withObservationTracking { _ = bridge.isReady } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.webView?.alpha = self.bridge.isReady ? 1 : 0
                self.observeReadiness()
            }
        }
    }
}

/// The SwiftUI chrome's container. It is as large as the page, but takes a touch only inside one of the chrome's
/// control regions; anywhere else hit testing returns nil, so UIKit continues with the sibling below it, the web view.
final class ChromeLayerView: UIView {
    var regions: [CGRect] = []

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard regions.contains(where: { $0.contains(point) }) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// The navigation bar's title view, as wide as the bar allows, so the title reads from the leading edge (like the real
/// app's `.principal` toolbar item) instead of being centered.
private final class LeadingTitleView: UIView {
    init(content: UIView) {
        super.init(frame: .zero)
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.layoutFittingExpandedSize.width, height: 44) }
}

/// AppSymbol's bundled template images for UIKit bar buttons.
enum AppSymbolImage {
    static func named(_ name: String, pointSize: CGFloat) -> UIImage? {
        guard let asset = AppSymbolAssets.names[name], let image = UIImage(named: asset) else { return UIImage(systemName: name) }
        let size = CGSize(width: pointSize, height: pointSize)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            .withRenderingMode(.alwaysTemplate)
    }
}
