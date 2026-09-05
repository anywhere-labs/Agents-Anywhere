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

/// A history request stays busy until its page has passed through the 30 Hz
/// presentation buffer and layout. Restoring a point retains the reader's
/// offset inside a long message, unlike aligning a group ID to the viewport top.
nonisolated struct TimelineHistoryPosition {
    let id: Int
    let origin: TimelineHistoryLayout?
    private let originOffset: CGFloat
    private var latestLayout: TimelineHistoryLayout?
    private var hasReceivedPage = false
    private var expectedFirstRowID: String?
    private var restorationCancelled = false
    private(set) var restoredOffset: CGFloat?

    init(id: Int, layout: TimelineHistoryLayout?, offsetY: CGFloat, topInset: CGFloat) {
        self.id = id
        origin = layout
        latestLayout = layout
        // An outward pull can still be bouncing when the request starts.
        originOffset = max(-topInset, offsetY)
    }

    var isReadyToFinish: Bool {
        hasReceivedPage && (expectedFirstRowID == nil || latestLayout?.firstRowID == expectedFirstRowID)
    }

    mutating func receivedPage(firstRowID: String?) {
        hasReceivedPage = true
        expectedFirstRowID = firstRowID
    }

    mutating func cancelRestoration() { restorationCancelled = true }

    mutating func laidOut(_ layout: TimelineHistoryLayout, generation: Int) -> CGFloat? {
        latestLayout = layout
        guard !restorationCancelled, generation == id, let origin,
              layout.anchorRowID == origin.anchorRowID, layout.edge == origin.edge,
              layout.firstRowID != origin.firstRowID else { return nil }
        let offset = originOffset + layout.y - origin.y
        guard abs(offset - (restoredOffset ?? originOffset)) > 0.5 else { return nil }
        restoredOffset = offset
        return offset
    }
}
