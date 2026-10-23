import Foundation

/// One measured, already-rendered group in content coordinates. Measuring the
/// anchor (instead of total content height) excludes simultaneous tail appends.
nonisolated struct TimelineHistoryLayout: Equatable {
    enum Edge { case top, bottom }
    let firstRowID: String
    let anchorRowID: String
    let edge: Edge
    let y: CGFloat
}

/// A history request stays busy until its page has passed through the 5 Hz
/// presentation buffer and layout. Restoring a point retains the reader's
/// offset inside a long message, unlike aligning a group ID to the viewport top.
nonisolated struct TimelineHistoryPosition: Equatable {
    let id: Int
    let origin: TimelineHistoryLayout?
    private let originOffset: CGFloat
    private var latestLayout: TimelineHistoryLayout?
    private var hasReceivedPage = false
    private var expectedFirstRowID: String?
    private var restorationCancelled = false
    private var presentedFirstRowID: String?
    private var requestedAnchorFor: String?
    private var restoredFirstRowID: String?
    private(set) var restoredOffset: CGFloat?

    init(id: Int, layout: TimelineHistoryLayout?, offsetY: CGFloat, topInset: CGFloat) {
        self.id = id
        origin = layout
        latestLayout = layout
        presentedFirstRowID = layout?.firstRowID
        // An outward pull can still be bouncing when the request starts.
        originOffset = max(-topInset, offsetY)
    }

    var isReadyToFinish: Bool {
        guard hasReceivedPage else { return false }
        if expectedFirstRowID == nil { return true }
        if restorationCancelled || origin == nil {
            return presentedFirstRowID == expectedFirstRowID
        }
        return latestLayout?.firstRowID == expectedFirstRowID
    }

    mutating func receivedPage(firstRowID: String?) {
        hasReceivedPage = true
        expectedFirstRowID = firstRowID
    }

    mutating func recordPresentation(firstRowID: String?) {
        presentedFirstRowID = firstRowID
    }

    /// Presentation is independent of materialization: a cancelled request must
    /// finish even when its original anchor is now outside the lazy viewport.
    @discardableResult mutating func presentedPage(firstRowID: String?) -> Bool {
        presentedFirstRowID = firstRowID
        guard !restorationCancelled, let origin, let firstRowID,
              firstRowID != origin.firstRowID, requestedAnchorFor != firstRowID,
              restoredFirstRowID != firstRowID else { return false }
        // Layout may arrive before this callback. Do not replace an already
        // measured point restoration with a viewport-edge identity target.
        requestedAnchorFor = firstRowID
        return true
    }

    mutating func cancelRestoration() { restorationCancelled = true }

    mutating func navigationChanged(generation: Int) {
        if generation != id { cancelRestoration() }
    }

    mutating func laidOut(_ layout: TimelineHistoryLayout, generation: Int) -> CGFloat? {
        latestLayout = layout
        presentedFirstRowID = layout.firstRowID
        guard !restorationCancelled, generation == id, let origin,
              layout.anchorRowID == origin.anchorRowID, layout.edge == origin.edge,
              layout.firstRowID != origin.firstRowID else { return nil }
        let offset = originOffset + layout.y - origin.y
        if restoredFirstRowID == layout.firstRowID,
           let restoredOffset, abs(offset - restoredOffset) <= 0.5 { return nil }
        restoredFirstRowID = layout.firstRowID
        restoredOffset = offset
        return offset
    }
}
