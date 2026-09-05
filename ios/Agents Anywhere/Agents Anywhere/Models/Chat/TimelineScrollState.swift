import Foundation

/// Explicit navigation wins over the old gesture's deceleration and geometry
/// callbacks. Only a new drag can cancel a requested return to the tail.
nonisolated struct TimelineScrollState: Equatable {
    enum Phase { case idle, tracking, interacting, decelerating, animating }
    private(set) var phase = Phase.idle
    private(set) var followsTail = true
    private(set) var returningToBottom = false
    private(set) var navigationGeneration = 0
    private(set) var interactionIsPresented = false
    var userIsScrolling: Bool { [.tracking, .interacting, .decelerating].contains(phase) }

    mutating func requestBottom() {
        followsTail = true; returningToBottom = true; navigationGeneration += 1
    }
    mutating func browseHistory() {
        followsTail = false; returningToBottom = false; navigationGeneration += 1
    }

    mutating func setInteractionPresented(_ presented: Bool) {
        guard interactionIsPresented != presented else { return }
        interactionIsPresented = presented
        // Invalidate an already queued return before the dock changes the inset.
        // Removing the card also preserves the reader's current position.
        browseHistory()
    }

    /// Returns whether a new user gesture took ownership of the scroll position.
    /// An animation can transition directly to interacting without tracking.
    @discardableResult mutating func phaseChanged(_ next: Phase, viewport: TimelineViewport) -> Bool {
        let beganGesture = next == .tracking && phase != .tracking
            || next == .interacting && phase != .tracking && phase != .interacting
        if beganGesture {
            browseHistory()
        }
        let wasScrolling = userIsScrolling
        phase = next
        // Use the phase callback's current geometry, never a cached geometry
        // callback. Merely being within a few lines of the tail is not consent
        // to resume following after the user has scrolled away.
        if wasScrolling && next == .idle && !returningToBottom { followsTail = viewport.isAtBottom }
        if next == .idle && returningToBottom && viewport.isAtBottom { returningToBottom = false }
        return beganGesture
    }
    mutating func geometryChanged(_ viewport: TimelineViewport) {
        if returningToBottom {
            if !userIsScrolling && viewport.isAtBottom { returningToBottom = false }
        } else if userIsScrolling { followsTail = viewport.isAtBottom }
    }
    func shouldFollow(_ viewport: TimelineViewport) -> Bool {
        (!interactionIsPresented || returningToBottom)
            && viewport.shouldFollowTail(isFollowing: followsTail, userIsScrolling: userIsScrolling && !returningToBottom)
    }
    func showsBottomButton(_ viewport: TimelineViewport) -> Bool {
        phase == .idle && !viewport.isNearBottom && (!followsTail || interactionIsPresented || returningToBottom)
    }
}
