import Foundation

/// Scroll policy is independent of SwiftUI layout callbacks. Inset-adjusted
/// measurements keep a short first response at the top, including with a keyboard.
nonisolated struct TimelineViewport: Equatable {
    let contentHeight: CGFloat
    let visibleHeight: CGFloat
    let visibleBottom: CGFloat

    init(contentHeight: CGFloat = 0, containerHeight: CGFloat = 0,
         topInset: CGFloat = 0, bottomInset: CGFloat = 0, offsetY: CGFloat = 0) {
        self.contentHeight = ceil(max(0, contentHeight))
        visibleHeight = floor(max(0, containerHeight - topInset - bottomInset))
        visibleBottom = floor(offsetY + containerHeight - bottomInset)
    }

    var hasOverflow: Bool { visibleHeight > 0 && contentHeight > visibleHeight + 1 }
    var distanceToBottom: CGFloat { max(0, contentHeight - visibleBottom) }
    var isNearBottom: Bool { !hasOverflow || distanceToBottom <= 70 }

    func shouldFollowTail(isFollowing: Bool, userIsScrolling: Bool) -> Bool {
        isFollowing && !userIsScrolling && hasOverflow && distanceToBottom > 1
    }
}
