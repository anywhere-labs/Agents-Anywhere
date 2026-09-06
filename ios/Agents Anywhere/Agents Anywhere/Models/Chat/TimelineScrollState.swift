import Foundation

/// One owner for opening, following and explicit returns. Native tail visibility
/// decides arrival; geometry only coalesces requests when the layout changes.
nonisolated struct TimelineScrollState: Equatable {
    enum Phase { case idle, tracking, interacting, decelerating, animating }
    enum Mode { case reading, following, returning }

    struct BottomRequest: Equatable {
        let generation: Int
        let contentHeight: CGFloat
        let visibleHeight: CGFloat
    }
    struct BottomCommand: Equatable {
        let id: Int
        let request: BottomRequest
    }

    private(set) var phase = Phase.idle
    private(set) var mode = Mode.reading
    private(set) var viewport = TimelineViewport()
    private(set) var tail = TimelineTailVisibility()
    private(set) var navigationGeneration = 0
    private(set) var interactionIsPresented = false
    private(set) var navigationIsSuspended = false
    private(set) var hasOpened = false
    private(set) var activeCommand: BottomCommand?
    private var lastRequest: BottomRequest?
    private var commandID = 0
    private var awaitsUserScrollSettlement = false

    var userIsScrolling: Bool { [.tracking, .interacting, .decelerating].contains(phase) }
    var returningToBottom: Bool { mode == .returning }
    var needsUserScrollSettlement: Bool {
        awaitsUserScrollSettlement && phase == .idle && tail.isMeasured && !navigationIsSuspended
    }

    mutating func open(interactionPresented: Bool = false) {
        guard !hasOpened else { return }
        hasOpened = true
        interactionIsPresented = interactionPresented
        requestBottom()
    }

    mutating func requestBottom() {
        mode = .returning
        awaitsUserScrollSettlement = false
        invalidateNavigation()
    }

    mutating func browseHistory() {
        mode = .reading
        awaitsUserScrollSettlement = false
        invalidateNavigation()
    }

    mutating func setInteractionPresented(_ presented: Bool) {
        guard interactionIsPresented != presented else { return }
        interactionIsPresented = presented
        if presented { browseHistory() }
        else { requestBottom() }
    }

    mutating func setNavigationSuspended(_ suspended: Bool) {
        guard navigationIsSuspended != suspended else { return }
        navigationIsSuspended = suspended
        // Preserve reading/history intent. A hidden or moving drawer cannot
        // retain a native edge target or acknowledge an interrupted animation.
        activeCommand = nil
        lastRequest = nil
    }

    mutating func geometryChanged(_ next: TimelineViewport) { viewport = next }

    mutating func tailVisibilityChanged(_ region: TimelineTailVisibility.Region, visible: Bool) {
        tail.update(region, visible: visible)
    }

    /// Phase and visibility callbacks can arrive in either order. Keep a manual
    /// drag in reading mode until both have settled, so a stale visible marker
    /// cannot grant auto-follow and pull the reader back down.
    @discardableResult mutating func phaseChanged(_ next: Phase, viewport: TimelineViewport) -> Bool {
        self.viewport = viewport
        guard !navigationIsSuspended else { return false }
        let beganGesture = next == .tracking && phase != .tracking
            || next == .interacting && phase != .tracking && phase != .interacting
        if beganGesture {
            browseHistory()
            awaitsUserScrollSettlement = true
        }
        phase = next
        return beganGesture
    }

    mutating func settleUserScroll() {
        guard needsUserScrollSettlement, !returningToBottom else { return }
        awaitsUserScrollSettlement = false
        mode = tail.isAtBottom && !interactionIsPresented ? .following : .reading
    }

    var pendingBottomRequest: BottomRequest? {
        guard hasOpened, !navigationIsSuspended, viewport.isMeasured,
              returningToBottom || tail.isMeasured,
              mode != .reading, !userIsScrolling || returningToBottom,
              !interactionIsPresented || returningToBottom else { return nil }
        // A return is issued once even for short content. Subsequent layout
        // changes only need correction when they actually move away from bottom.
        if tail.isAtBottom && (mode == .following || lastRequest != nil) { return nil }
        let request = BottomRequest(generation: navigationGeneration,
            contentHeight: viewport.contentHeight.rounded(), visibleHeight: viewport.visibleHeight.rounded())
        return request == lastRequest ? nil : request
    }

    mutating func begin(_ request: BottomRequest) -> BottomCommand? {
        guard pendingBottomRequest == request else { return nil }
        commandID &+= 1
        let command = BottomCommand(id: commandID, request: request)
        lastRequest = request
        activeCommand = command
        return command
    }

    /// Only the latest animation can release ScrollPosition. A new gesture,
    /// approval or drawer transition invalidates an old completion immediately.
    mutating func complete(_ command: BottomCommand) -> Bool {
        guard activeCommand == command else { return false }
        activeCommand = nil
        if returningToBottom { mode = interactionIsPresented ? .reading : .following }
        return true
    }

    func showsBottomButton() -> Bool {
        hasOpened && !navigationIsSuspended && phase == .idle && tail.isMeasured
            && !tail.isNearBottom && activeCommand == nil && pendingBottomRequest == nil
    }

    private mutating func invalidateNavigation() {
        navigationGeneration &+= 1
        lastRequest = nil
        activeCommand = nil
    }
}

/// Two probes overlap the existing tail spacer. The larger region provides the
/// return pill's 96-point margin; only the end marker grants automatic following.
nonisolated struct TimelineTailVisibility: Equatable {
    enum Region { case near, end }
    private var near: Bool?
    private var end: Bool?
    var isMeasured: Bool { near != nil && end != nil }
    var isAtBottom: Bool { end == true }
    var isNearBottom: Bool { isAtBottom || near != false }

    mutating func update(_ region: Region, visible: Bool) {
        switch region {
        case .near: near = visible
        case .end: end = visible
        }
    }
}
