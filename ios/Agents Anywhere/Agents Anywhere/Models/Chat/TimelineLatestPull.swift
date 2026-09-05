import Foundation

/// A fresh upward pull on an already visible history footer loads the latest
/// window once on release. Inertia, automatic scrolling and resizing cannot arm it.
nonisolated struct TimelineLatestPull {
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
        isReady = viewport.visibleBottom - origin.visibleBottom >= 24
    }

    mutating func end() -> Bool {
        let shouldLoad = isReady
        cancel()
        return shouldLoad
    }

    mutating func cancel() { origin = nil; isReady = false }
}
