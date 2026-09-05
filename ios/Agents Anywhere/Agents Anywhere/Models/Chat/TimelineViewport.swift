import Foundation

/// Native scroll geometry in content coordinates. Insets are counted once;
/// horizontal window clipping and screen-space visibility never enter the math.
nonisolated struct TimelineViewport: Equatable {
    let contentHeight: CGFloat
    let visibleHeight: CGFloat
    let visibleBottom: CGFloat
    let offsetY: CGFloat
    let topInset: CGFloat
    let bottomOffset: CGFloat

    init(contentHeight: CGFloat = 0, containerHeight: CGFloat = 0,
         topInset: CGFloat = 0, bottomInset: CGFloat = 0, offsetY: CGFloat = 0) {
        self.contentHeight = max(0, contentHeight)
        visibleHeight = max(0, containerHeight - topInset - bottomInset)
        visibleBottom = offsetY + containerHeight - bottomInset
        self.offsetY = offsetY
        self.topInset = topInset
        bottomOffset = max(-topInset, self.contentHeight + bottomInset - containerHeight)
    }
    var isMeasured: Bool { visibleHeight > 0 }
    var distanceToBottom: CGFloat { max(0, bottomOffset - offsetY) }
    // Arrival allows native rounding and small inset changes. The pill uses a
    // wider margin, without silently granting near-bottom readers auto-follow.
    var isAtBottom: Bool { isMeasured && distanceToBottom <= 8 }
    var isNearBottom: Bool { isMeasured && distanceToBottom <= 96 }
}
