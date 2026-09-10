import SwiftUI

/// Place in the background of the page's primary scroll content. Catalyst's
/// navigation bar cannot reliably infer that scroll view through our nested
/// geometry, timeline overlays and independently scrolling editors.
struct ChatPageScrollEdge: View {
    var body: some View {
        #if targetEnvironment(macCatalyst)
        CatalystPageScrollEdge()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        #endif
    }
}

#if targetEnvironment(macCatalyst)
import UIKit

private struct CatalystPageScrollEdge: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ChatPageScrollEdgeController {
        ChatPageScrollEdgeController()
    }

    func updateUIViewController(_ controller: ChatPageScrollEdgeController, context: Context) {
        controller.scheduleRegistration()
    }

    static func dismantleUIViewController(_ controller: ChatPageScrollEdgeController, coordinator: ()) {
        controller.stopRegistration()
    }
}

final class ChatPageScrollEdgeController: UIViewController {
    private weak var registeredPage: UIViewController?
    private weak var registeredScrollView: UIScrollView?
    private var registrationScheduled = false
    private var isActive = true

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { disconnect() }
        else { scheduleRegistration() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        registerScrollView()
    }

    func scheduleRegistration() {
        guard isActive, !registrationScheduled else { return }
        registrationScheduled = true
        // The controller and its view can attach in separate SwiftUI updates.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.registrationScheduled = false
            self.registerScrollView()
        }
    }

    func stopRegistration() {
        isActive = false
        disconnect()
    }

    private func registerScrollView() {
        guard isActive, let scrollView = enclosingScrollView(), let page = navigationPage() else { return }
        if registeredPage === page, registeredScrollView === scrollView,
           let current = page.contentScrollView(for: .top), current !== scrollView {
            // Another page has taken over this navigation host. Late layout
            // or attachment callbacks from the outgoing content must yield.
            return
        }
        if registeredPage !== page || registeredScrollView !== scrollView {
            disconnect()
            registeredPage = page
            registeredScrollView = scrollView
        }
        if scrollView.topEdgeEffect.style !== UIScrollEdgeEffect.Style.soft {
            scrollView.topEdgeEffect.style = .soft
        }
        if page.contentScrollView(for: .top) !== scrollView {
            page.setContentScrollView(scrollView, for: .top)
        }
    }

    private func enclosingScrollView() -> UIScrollView? {
        var ancestor = viewIfLoaded?.superview
        while let current = ancestor {
            if let scrollView = current as? UIScrollView { return scrollView }
            ancestor = current.superview
        }
        return nil
    }

    private func navigationPage() -> UIViewController? {
        var ancestor = parent
        while let current = ancestor {
            if let navigation = current.parent as? UINavigationController {
                return navigation.topViewController === current ? current : nil
            }
            ancestor = current.parent
        }
        return nil
    }

    private func disconnect() {
        // An outgoing page must not clear a newer page's registration.
        if let registeredPage, let registeredScrollView,
           registeredPage.contentScrollView(for: .top) === registeredScrollView {
            registeredPage.setContentScrollView(nil, for: .top)
        }
        registeredPage = nil
        registeredScrollView = nil
    }
}
#endif
