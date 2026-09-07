import SwiftUI

/// The sidebar's native navigation host must keep its settled coordinates
/// throughout the reveal. Apply with ignoredByLayout(), like the detail card's
/// translation, so scaling cannot change the bar or scroll view's safe area.
nonisolated struct SidebarDrawerScale: GeometryEffect {
    var scale: CGFloat
    var anchor: UnitPoint = .center

    var animatableData: CGFloat {
        get { scale }
        set { scale = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(
            a: scale, b: 0, c: 0, d: scale,
            tx: size.width * anchor.x * (1 - scale),
            ty: size.height * anchor.y * (1 - scale)
        ))
    }

    /// UIView applies its transform around its bounds' center. Compensate for
    /// that origin without changing layer.anchorPoint, bounds or constraints.
    func viewTransform(size: CGSize) -> CGAffineTransform {
        CGAffineTransform(
            a: scale, b: 0, c: 0, d: scale,
            tx: size.width * (anchor.x - 0.5) * (1 - scale),
            ty: size.height * (anchor.y - 0.5) * (1 - scale)
        )
    }
}
