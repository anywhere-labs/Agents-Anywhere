import SwiftUI

/// Screen-space hit area for the exposed main card. Keep this outside the
/// ignored-by-layout translation so it cannot cover the visible sidebar.
nonisolated struct SidebarDrawerCloseRegion: Shape {
    var leadingEdge: CGFloat
    var animatableData: CGFloat {
        get { leadingEdge }
        set { leadingEdge = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let inset = min(max(leadingEdge, 0), rect.width)
        return Path(CGRect(x: rect.minX + inset, y: rect.minY,
            width: rect.width - inset, height: rect.height))
    }
}
