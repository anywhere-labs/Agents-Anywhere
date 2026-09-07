#if targetEnvironment(macCatalyst)
import SwiftUI
import UIKit

/// Configure the containing scene, including additional windows, without
/// replacing SwiftUI's scene delegate or its native navigation toolbar.
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
            guard let titlebar = window?.windowScene?.titlebar,
                  titlebar.titleVisibility != .hidden else { return }
            titlebar.titleVisibility = .hidden
        }
    }
}
#endif
