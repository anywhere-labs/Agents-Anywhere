#if canImport(UIKit)
import SwiftUI
import UIKit

/// Own the drawer's native bars, glass controls and content under one UIKit
/// surface. A SwiftUI drawing transform alone doesn't own those native layers.
struct SidebarDrawerHostingView<Content: View>: UIViewControllerRepresentable {
    let scale: CGFloat
    let overlayOpacity: CGFloat
    @ViewBuilder let content: () -> Content

    func makeUIViewController(context: Context) -> SidebarDrawerHostingController<Content> {
        let controller = SidebarDrawerHostingController(
            content: content(), environment: context.environment
        )
        controller.loadViewIfNeeded()
        controller.setPresentation(scale: scale, overlayOpacity: overlayOpacity)
        return controller
    }

    func updateUIViewController(_ controller: SidebarDrawerHostingController<Content>, context: Context) {
        controller.update(content: content(), environment: context.environment)
        // Reuse the drawer's SwiftUI transaction, including its spring and
        // interactive, nonanimated drag updates. There is no second animation.
        context.animate {
            controller.setPresentation(scale: scale, overlayOpacity: overlayOpacity)
        }
    }
}

final class SidebarDrawerHostingController<Content: View>: UIViewController {
    private let hostingController: UIHostingController<SidebarDrawerHostedContent<Content>>
    private let surface = UIView()
    private let dimmingView = UIView()

    init(content: Content, environment: EnvironmentValues) {
        hostingController = UIHostingController(rootView: SidebarDrawerHostedContent(
            content: content, environment: environment
        ))
        // The untransformed drawer supplies its original safe-area insets.
        // Re-reading window intersections while scaling would move the bars
        // when the animation reaches its final, unscaled frame.
        hostingController.safeAreaRegions = []
        super.init(nibName: nil, bundle: nil)
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

    func update(content: Content, environment: EnvironmentValues) {
        hostingController.rootView = SidebarDrawerHostedContent(content: content, environment: environment)
        overrideUserInterfaceStyle = environment.colorScheme == .dark ? .dark : .light
    }

    func setPresentation(scale: CGFloat, overlayOpacity: CGFloat) {
        // Leave bounds, constraints and the default center anchor unchanged.
        // Every descendant, including UIToolbar, receives this one transform.
        surface.transform = CGAffineTransform(scaleX: scale, y: scale)
        dimmingView.alpha = overlayOpacity
    }

    private func pin(_ child: UIView, to parent: UIView) {
        child.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(child)
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
            child.topAnchor.constraint(equalTo: parent.topAnchor),
            child.bottomAnchor.constraint(equalTo: parent.bottomAnchor)
        ])
    }
}

private struct SidebarDrawerHostedContent<Content: View>: View {
    let content: Content
    let environment: EnvironmentValues

    var body: some View {
        // A UIHostingController starts a new SwiftUI tree. Forward the complete
        // environment, including AppState, locale and accessibility settings.
        content.environment(\.self, environment)
    }
}
#endif
