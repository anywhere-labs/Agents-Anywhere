import SwiftUI

#if canImport(UIKit)
import UIKit

/// Keep the native navigation/toolbar controls and the list under one transform.
/// The untransformed parent owns safe areas; the list viewport supplies the pivot.
struct SidebarDrawerHostingView<Content: View>: UIViewControllerRepresentable {
    let scale: CGFloat
    let overlayOpacity: CGFloat
    @ViewBuilder let content: () -> Content

    func makeUIViewController(context: Context) -> SidebarDrawerHostingController<Content> {
        let controller = SidebarDrawerHostingController(content: content(), environment: context.environment)
        controller.loadViewIfNeeded()
        controller.setPresentation(scale: scale, overlayOpacity: overlayOpacity)
        return controller
    }

    func updateUIViewController(_ controller: SidebarDrawerHostingController<Content>, context: Context) {
        controller.update(content: content(), environment: context.environment)
        // Interactive changes and the settling spring use the drawer's existing
        // transaction. Neither the toolbar nor the list starts another animation.
        context.animate {
            controller.setPresentation(scale: scale, overlayOpacity: overlayOpacity)
        }
    }
}

final class SidebarDrawerHostingController<Content: View>: UIViewController {
    private let hostingController: UIHostingController<SidebarDrawerHostedContent<Content>>
    private let surface = UIView()
    private let dimmingView = UIView()
    private let viewport = SidebarDrawerViewport()
    private var content: Content
    private var environment: EnvironmentValues
    private var containerInsets = UIEdgeInsets.zero
    private var scale: CGFloat = 1

    init(content: Content, environment: EnvironmentValues) {
        self.content = content
        self.environment = environment
        hostingController = UIHostingController(rootView: SidebarDrawerHostedContent(
            content: content, environment: environment, viewport: viewport, insets: .init()
        ))
        // The transformed host must not derive a second safe area from its
        // changing intersection with the window or the detail page's keyboard.
        hostingController.safeAreaRegions = []
        super.init(nibName: nil, bundle: nil)
        viewport.onLayout = { [weak self] in self?.updateTransform() }
        overrideUserInterfaceStyle = environment.colorScheme == .dark ? .dark : .light
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        surface.backgroundColor = .systemBackground
        pin(surface, to: view)

        addChild(hostingController)
        hostingController.view.backgroundColor = .clear
        pin(hostingController.view, to: surface)
        hostingController.didMove(toParent: self)

        dimmingView.backgroundColor = .systemBackground
        dimmingView.isUserInteractionEnabled = false
        dimmingView.accessibilityElementsHidden = true
        pin(dimmingView, to: surface)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        updateContainerInsets()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateContainerInsets()
        updateTransform()
    }

    func update(content: Content, environment: EnvironmentValues) {
        self.content = content
        self.environment = environment
        overrideUserInterfaceStyle = environment.colorScheme == .dark ? .dark : .light
        updateRootView()
    }

    func setPresentation(scale: CGFloat, overlayOpacity: CGFloat) {
        self.scale = scale
        dimmingView.alpha = overlayOpacity
        updateTransform()
    }

    private func updateContainerInsets() {
        // This view never scales. UIKit's container safe area excludes the
        // keyboard, which belongs to the detail page, and is restored only here.
        guard view.safeAreaInsets != containerInsets else { return }
        containerInsets = view.safeAreaInsets
        updateRootView()
    }

    private func updateRootView() {
        let isRTL = environment.layoutDirection == .rightToLeft
        hostingController.rootView = SidebarDrawerHostedContent(
            content: content, environment: environment, viewport: viewport,
            insets: EdgeInsets(top: containerInsets.top,
                leading: isRTL ? containerInsets.right : containerInsets.left,
                bottom: containerInsets.bottom,
                trailing: isRTL ? containerInsets.left : containerInsets.right)
        )
    }

    private func updateTransform() {
        let bounds = surface.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        var anchor = UnitPoint.center
        if let marker = viewport.view, marker.isDescendant(of: surface) {
            // Both endpoints are inside the same native surface. Its transform
            // cancels from this conversion, so measuring never feeds back scale.
            let rect = marker.convert(marker.bounds, to: surface).intersection(bounds)
            if !rect.isNull, rect.width > 0, rect.height > 0 {
                anchor = UnitPoint(x: (rect.midX - bounds.minX) / bounds.width,
                    y: (rect.midY - bounds.minY) / bounds.height)
            }
        }
        let transform = SidebarDrawerScale(scale: scale, anchor: anchor).viewTransform(size: bounds.size)
        if surface.transform != transform { surface.transform = transform }
    }

    private func pin(_ child: UIView, to parent: UIView) {
        child.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(child)
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
            child.topAnchor.constraint(equalTo: parent.topAnchor),
            child.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
        ])
    }
}

private struct SidebarDrawerHostedContent<Content: View>: View {
    let content: Content
    let environment: EnvironmentValues
    let viewport: SidebarDrawerViewport
    let insets: EdgeInsets

    var body: some View {
        content
            .safeAreaPadding(insets)
            .environment(\.sidebarDrawerViewport, viewport)
            // Forward the original styles, locale, accessibility and AppState.
            .environment(\.self, environment)
    }
}

private final class SidebarDrawerViewport {
    weak var view: UIView?
    var onLayout: (() -> Void)?
}

private struct SidebarDrawerViewportKey: EnvironmentKey {
    static let defaultValue: SidebarDrawerViewport? = nil
}

private extension EnvironmentValues {
    var sidebarDrawerViewport: SidebarDrawerViewport? {
        get { self[SidebarDrawerViewportKey.self] }
        set { self[SidebarDrawerViewportKey.self] = newValue }
    }
}

private struct SidebarDrawerViewportReader: UIViewRepresentable {
    let viewport: SidebarDrawerViewport

    func makeUIView(context: Context) -> SidebarDrawerViewportView {
        let view = SidebarDrawerViewportView()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.viewport = viewport
        return view
    }

    func updateUIView(_ view: SidebarDrawerViewportView, context: Context) {
        view.viewport = viewport
    }
}

private final class SidebarDrawerViewportView: UIView {
    weak var viewport: SidebarDrawerViewport?

    override func layoutSubviews() {
        super.layoutSubviews()
        viewport?.view = self
        viewport?.onLayout?()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        viewport?.view = self
        viewport?.onLayout?()
    }
}
#endif

/// Measure the ScrollView itself, never its scrolling or lazily loaded content.
struct SidebarDrawerViewportMeasurement: ViewModifier {
#if canImport(UIKit)
    @Environment(\.sidebarDrawerViewport) private var viewport
#endif

    func body(content: Content) -> some View {
        content
#if canImport(UIKit)
            .background {
                if let viewport { SidebarDrawerViewportReader(viewport: viewport) }
            }
#endif
    }
}
