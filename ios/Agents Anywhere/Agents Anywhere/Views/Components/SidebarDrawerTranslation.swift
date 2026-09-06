import SwiftUI

/// Use with ignoredByLayout() to move the live card without moving its layout
/// origin. The system still interpolates every frame of the drawer's spring.
nonisolated struct SidebarDrawerTranslation: GeometryEffect {
    var x: CGFloat

    var animatableData: CGFloat {
        get { x }
        set { x = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: x, y: 0))
    }
}
