import Foundation

/// One owner for opening, following and explicit returns. Geometry describes
/// where the viewport is; only user/navigation events change reading intent.
nonisolated struct TimelineScrollState: Equatable {
    enum Phase { case idle, tracking, interacting, decelerating, animating }
    enum Mode { case reading, following, returning }

    struct BottomRequest: Equatable {
        let generation: Int
        // A finite native offset, rounded to avoid subpixel retargeting. Unlike
        // a persistent bottom edge, this cannot also follow layout on its own.
        let bottomOffset: CGFloat
    }
    struct BottomCommand: Equatable {
        let id: Int
        let request: BottomRequest
    }

    private(set) var phase = Phase.idle
    private(set) var mode = Mode.reading
    private(set) var viewport = TimelineViewport()
    private(set) var navigationGeneration = 0
    private(set) var interactionIsPresented = false
    private(set) var navigationIsSuspended = false
    private(set) var hasOpened = false
    private(set) var activeCommand: BottomCommand?
    private var lastRequest: BottomRequest?
    private var commandID = 0

    var userIsScrolling: Bool { [.tracking, .interacting, .decelerating].contains(phase) }
    var returningToBottom: Bool { mode == .returning }

    mutating func open(interactionPresented: Bool = false) {
        guard !hasOpened else { return }
        hasOpened = true
        interactionIsPresented = interactionPresented
        requestBottom()
    }

    mutating func requestBottom() {
        mode = .returning
        invalidateNavigation()
    }

    mutating func browseHistory() {
        mode = .reading
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

    /// Phase callbacks carry the current geometry, so manual arrival needs no
    /// visibility probes or delayed guess about the order of two callbacks.
    @discardableResult mutating func phaseChanged(_ next: Phase, viewport: TimelineViewport) -> Bool {
        self.viewport = viewport
        guard !navigationIsSuspended else { return false }
        let beganGesture = next == .tracking && phase != .tracking
            || next == .interacting && phase != .tracking && phase != .interacting
        let wasScrolling = userIsScrolling
        if beganGesture { browseHistory() }
        phase = next
        if wasScrolling, next == .idle, !returningToBottom {
            mode = viewport.isAtBottom && !interactionIsPresented ? .following : .reading
        }
        return beganGesture
    }

    var pendingBottomRequest: BottomRequest? {
        guard hasOpened, !navigationIsSuspended, viewport.isMeasured,
              mode != .reading, !userIsScrolling || returningToBottom,
              !interactionIsPresented || returningToBottom else { return nil }
        // A return is issued once even for short content. Subsequent layout
        // changes only need correction when they actually move away from bottom.
        if viewport.isAtBottom && (mode == .following || lastRequest != nil) { return nil }
        let request = BottomRequest(generation: navigationGeneration, bottomOffset: viewport.bottomOffset.rounded())
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
        hasOpened && !navigationIsSuspended && phase == .idle && viewport.isMeasured
            && !viewport.isNearBottom && activeCommand == nil && pendingBottomRequest == nil
    }

    private mutating func invalidateNavigation() {
        navigationGeneration &+= 1
        lastRequest = nil
        activeCommand = nil
    }
}
