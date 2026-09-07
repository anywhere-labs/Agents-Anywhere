#if targetEnvironment(macCatalyst)
import SwiftUI
import UIKit

/// Remove Catalyst's extra title bar; page controls remain in their UIKit
/// navigation bars. Configure each containing scene without replacing its delegate.
struct MacCatalystWindowTitle: UIViewRepresentable {
    func makeUIView(context: Context) -> TitlebarView { TitlebarView() }

    func updateUIView(_ uiView: TitlebarView, context: Context) {
        uiView.hideWindowTitle()
    }

    final class TitlebarView: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            hideWindowTitle()
        }

        func hideWindowTitle() {
            guard let titlebar = window?.windowScene?.titlebar else { return }
            titlebar.titleVisibility = .hidden
            // Hiding only the title leaves the window toolbar's empty strip.
            titlebar.toolbar = nil
        }
    }
}
#endif
