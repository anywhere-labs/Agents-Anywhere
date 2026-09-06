import Foundation

/// A render-only translation does not relocate content hit targets. The phone
/// drawer therefore hands interaction to one settled surface at a time.
nonisolated struct DrawerInteractionState {
    let isOpen: Bool
    let progress: CGFloat
    let isAnimating: Bool
    let isDragging: Bool

    var acceptsContentTouches: Bool {
        !isOpen && !isAnimating && !isDragging && progress <= 0.001
    }
    var acceptsSidebarTouches: Bool {
        isOpen && !isAnimating && !isDragging && progress >= 0.999
    }
}
