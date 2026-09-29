import SwiftUI

/// Apply to the content inside the scroll view. The scroll viewport stays full
/// width while both detail pages share the session's ordinary centered layout.
/// Card pages keep a fixed margin; a nil inset follows the navigation bar's
/// system margin so chat text lines up with the bar's glass buttons.
struct ChatPageContentColumn: ViewModifier {
    var horizontalInset: CGFloat? = 24
    @State private var containerWidth: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, horizontalInset ?? systemMargin).padding(.top, 16)
            .frame(maxWidth: 760).frame(maxWidth: .infinity)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
    }

    /// UIKit widens layout margins from 16pt to 20pt on wide phones (Plus/Max,
    /// Air) and on iPad, which is where the bar places its buttons.
    private var systemMargin: CGFloat { containerWidth >= 414 ? 20 : 16 }
}
