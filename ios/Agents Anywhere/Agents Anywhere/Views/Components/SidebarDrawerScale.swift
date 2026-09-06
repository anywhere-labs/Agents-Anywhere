import SwiftUI

/// The sidebar's native navigation host must keep its settled coordinates
/// throughout the reveal. Apply with ignoredByLayout(), like the detail card's
/// translation, so scaling cannot change the bar or scroll view's safe area.
nonisolated struct SidebarDrawerScale: GeometryEffect {
    var scale: CGFloat

    var animatableData: CGFloat {
        get { scale }
        set { scale = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(
            a: scale, b: 0, c: 0, d: scale,
            tx: size.width * (1 - scale) / 2,
            ty: size.height * (1 - scale) / 2
        ))
    }
}
