import Foundation

/// One fresh pull beyond a visible history edge loads one page on release.
/// Inertia, automatic scrolling and resizing cannot arm either edge.
nonisolated struct TimelineHistoryPull {
    enum Edge { case older, latest }
    var edge = Edge.latest
    private var origin: TimelineViewport?
    private(set) var isReady = false

    mutating func begin(at viewport: TimelineViewport, promptVisible: Bool, canLoad: Bool) {
        origin = promptVisible && canLoad ? viewport : nil
        isReady = false
    }

    mutating func update(_ viewport: TimelineViewport) {
        guard let origin else { return }
        guard abs(viewport.contentHeight - origin.contentHeight) <= 2,
              abs(viewport.visibleHeight - origin.visibleHeight) <= 2 else {
            cancel()
            return
        }
        let movement = viewport.visibleBottom - origin.visibleBottom
        isReady = (edge == .latest ? movement : -movement) >= 24
    }

    mutating func end() -> Bool {
        let shouldLoad = isReady
        cancel()
        return shouldLoad
    }

    mutating func cancel() { origin = nil; isReady = false }
}
