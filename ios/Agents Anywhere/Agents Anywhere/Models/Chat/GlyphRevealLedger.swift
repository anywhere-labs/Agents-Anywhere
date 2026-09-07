import Foundation

/// One reveal curve drives opacity, blur and translation without changing the
/// text's measured size. Geometry always uses the final, untransformed glyphs.
nonisolated struct GlyphRevealEffect {
    let progress: Double
    var opacity: Double { progress }
    var blurRadius: Double { 3 * (1 - progress) }
    var offsetY: Double { 3 * (1 - progress) }
}

/// TextRenderer may draw off the main actor. Birth times belong to the newly
/// appended glyphs; a later flush never restarts an earlier batch's animation.
nonisolated final class GlyphRevealLedger: @unchecked Sendable {
    private let lock = NSLock()
    private let duration: TimeInterval
    private var settledCount = 0
    // Only the newly revealed suffix needs per-glyph birth times. Static
    // history must not allocate a character-sized array on every draw.
    private var births: [TimeInterval] = []

    init(duration: TimeInterval = ReplyPresentation.revealSeconds) {
        precondition(duration > 0 && duration.isFinite)
        self.duration = duration
    }

    func progress(count: Int, now: TimeInterval, enabled: Bool) -> [Double]? {
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
        if revealingCount < births.count { births.removeLast(births.count - revealingCount) }
        if revealingCount > births.count {
            births.append(contentsOf: repeatElement(now, count: revealingCount - births.count))
        }
        guard births.contains(where: { now - $0 < duration }) else {
            settledCount = count
            births.removeAll(keepingCapacity: true)
            return nil
        }
        return Array(repeating: 1, count: settledCount) + births.map { born in
            let progress = min(1, max(0, (now - born) / duration))
            return 1 - pow(1 - progress, 3)
        }
    }
}
