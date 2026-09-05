import Foundation

/// Scroll intent is independent of content-size estimates. SwiftUI reports the
/// visibility of two real tail markers, including the 96-point return margin.
nonisolated struct TimelineScrollState: Equatable {
    enum Phase { case idle, tracking, interacting, decelerating, animating }
    private(set) var phase = Phase.idle
    private(set) var followsTail = true
    private(set) var returningToBottom = false
    private(set) var navigationGeneration = 0
    private(set) var interactionIsPresented = false
    private(set) var tail = TimelineTailVisibility()
    private var awaitsUserScrollSettlement = false
    var userIsScrolling: Bool { [.tracking, .interacting, .decelerating].contains(phase) }
    var needsScrollSettlement: Bool { phase == .idle && awaitsUserScrollSettlement && tail.isMeasured }

    mutating func requestBottom() {
        followsTail = true; returningToBottom = true; navigationGeneration += 1
        awaitsUserScrollSettlement = false
    }
    mutating func browseHistory() {
        followsTail = false; returningToBottom = false; navigationGeneration += 1
        awaitsUserScrollSettlement = false
    }
    mutating func setInteractionPresented(_ presented: Bool) {
        guard interactionIsPresented != presented else { return }
        interactionIsPresented = presented
        browseHistory()
    }

    @discardableResult mutating func phaseChanged(_ next: Phase) -> Bool {
        let beganGesture = next == .tracking && phase != .tracking
            || next == .interacting && phase != .tracking && phase != .interacting
        if beganGesture {
            browseHistory()
            awaitsUserScrollSettlement = true
        }
        phase = next
        finishReturnIfVisible()
        return beganGesture
    }
    mutating func tailVisibilityChanged(_ region: TimelineTailVisibility.Region, visible: Bool) {
        tail.update(region, visible: visible)
        finishReturnIfVisible()
    }
    private mutating func finishReturnIfVisible() {
        if returningToBottom && !userIsScrolling && tail.isAtBottom { returningToBottom = false }
    }
    /// Visibility and phase callbacks can arrive in either order. The view waits
    /// for a quiet layout tick before granting a completed drag auto-follow.
    mutating func settleUserScroll() {
        guard needsScrollSettlement, !returningToBottom else { return }
        awaitsUserScrollSettlement = false
        followsTail = tail.isAtBottom
    }
    func shouldFollow() -> Bool {
        tail.isMeasured && !tail.isAtBottom && followsTail
            && (!userIsScrolling || returningToBottom)
            && (!interactionIsPresented || returningToBottom)
    }
    func showsBottomButton() -> Bool {
        phase == .idle && tail.isMeasured && !tail.isNearBottom
            && (!followsTail || interactionIsPresented || returningToBottom)
    }
}

nonisolated struct TimelineTailVisibility: Equatable {
    enum Region { case near, end }
    private var near: Bool?
    private var end: Bool?
    var isMeasured: Bool { end != nil && near != nil }
    var isAtBottom: Bool { end == true }
    // The end marker wins if the two callbacks arrive in different orders.
    var isNearBottom: Bool { isAtBottom || near != false }
    mutating func update(_ region: Region, visible: Bool) {
        switch region { case .near: near = visible; case .end: end = visible }
    }
}
