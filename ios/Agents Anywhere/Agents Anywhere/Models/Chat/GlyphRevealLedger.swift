import Foundation

/// One reveal curve drives opacity, blur and translation without changing the
/// text's measured size. Geometry always uses the final, untransformed glyphs.
nonisolated struct GlyphRevealEffect {
    let progress: Double
    var opacity: Double { progress }
    var blurRadius: Double { 3 * (1 - progress) }
    var offsetY: Double { 3 * (1 - progress) }
}

/// Glyphs before `settledCount` draw normally. Each batch is one flush's
/// appended glyphs; they were born together and share one reveal progress.
nonisolated struct GlyphRevealProgress: Equatable {
    struct Batch: Equatable {
        let range: Range<Int>
        let progress: Double
    }

    let settledCount: Int
    let batches: [Batch]

    func value(at index: Int) -> Double {
        batches.first { $0.range.contains(index) }?.progress ?? 1
    }
}

/// TextRenderer may draw off the main actor. Birth times belong to the newly
/// appended glyphs; a later flush never restarts an earlier batch's animation.
nonisolated final class GlyphRevealLedger: @unchecked Sendable {
    private let lock = NSLock()
    private let duration: TimeInterval
    private var settledCount = 0
    // One entry per flush, oldest first. A frame costs O(batches), not
    // O(characters), however long the paragraph grows.
    private var births: [(count: Int, born: TimeInterval)] = []

    init(duration: TimeInterval = ReplyPresentation.revealSeconds) {
        precondition(duration > 0 && duration.isFinite)
        self.duration = duration
    }

    func progress(count: Int, now: TimeInterval, enabled: Bool) -> GlyphRevealProgress? {
        lock.lock()
        defer { lock.unlock() }
        // Textual can briefly emit an empty Text while rebuilding a heading or
        // fragment. That intermediate draw must not erase earlier glyph births.
        guard count > 0 else { return nil }
        guard enabled else {
            settledCount = count
            births.removeAll(keepingCapacity: false)
            return nil
        }
        settledCount = min(settledCount, count)
        let revealingCount = count - settledCount
        var birthCount = births.reduce(0) { $0 + $1.count }
        while birthCount > revealingCount, let last = births.last {
            let removed = min(last.count, birthCount - revealingCount)
            if removed == last.count { births.removeLast() } else { births[births.count - 1].count -= removed }
            birthCount -= removed
        }
        if revealingCount > birthCount { births.append((revealingCount - birthCount, now)) }
        // Finished batches join the settled prefix and leave the per-frame work.
        while let first = births.first, now - first.born >= duration {
            settledCount += first.count
            births.removeFirst()
        }
        guard !births.isEmpty else { return nil }
        var start = settledCount
        return GlyphRevealProgress(settledCount: settledCount, batches: births.map { birth in
            defer { start += birth.count }
            let progress = min(1, max(0, (now - birth.born) / duration))
            return .init(range: start..<(start + birth.count), progress: 1 - pow(1 - progress, 3))
        })
    }
}
