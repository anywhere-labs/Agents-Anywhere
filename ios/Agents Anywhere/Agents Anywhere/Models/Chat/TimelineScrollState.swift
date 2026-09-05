import Foundation

/// Explicit navigation wins over the old gesture's deceleration and geometry
/// callbacks. Only a new drag can cancel a requested return to the tail.
nonisolated struct TimelineScrollState: Equatable {
    enum Phase { case idle, tracking, interacting, decelerating, animating }
    private(set) var phase = Phase.idle
    private(set) var followsTail = true
    private(set) var returningToBottom = false
    private(set) var returnGeneration = 0
    var userIsScrolling: Bool { [.tracking, .interacting, .decelerating].contains(phase) }

    mutating func requestBottom() {
        followsTail = true; returningToBottom = true; returnGeneration += 1
    }
    mutating func browseHistory() { followsTail = false; returningToBottom = false }
    mutating func phaseChanged(_ next: Phase, viewport: TimelineViewport) {
        if next == .tracking && phase != .tracking {
            returningToBottom = false
            followsTail = viewport.isNearBottom
        }
        let wasScrolling = userIsScrolling
        phase = next
        if wasScrolling && next == .idle && !returningToBottom { followsTail = viewport.isNearBottom }
        if next == .idle && returningToBottom && viewport.distanceToBottom <= 1 { returningToBottom = false }
    }
    mutating func geometryChanged(_ viewport: TimelineViewport) {
        if returningToBottom {
            if !userIsScrolling && (!viewport.hasOverflow || viewport.distanceToBottom <= 1) { returningToBottom = false }
        } else if userIsScrolling { followsTail = viewport.isNearBottom }
    }
    func shouldFollow(_ viewport: TimelineViewport) -> Bool {
        viewport.shouldFollowTail(isFollowing: followsTail, userIsScrolling: userIsScrolling && !returningToBottom)
    }
}
