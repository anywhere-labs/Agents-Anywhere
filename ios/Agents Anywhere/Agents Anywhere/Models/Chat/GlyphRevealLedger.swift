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
    private var births: [TimeInterval] = []

    func progress(count: Int, now: TimeInterval, enabled: Bool) -> [Double]? {
        lock.lock()
        defer { lock.unlock() }
        // Textual can briefly emit an empty Text while rebuilding a heading or
        // fragment. That intermediate draw must not erase earlier glyph births.
        guard count > 0 else { return nil }
        let duration = ReplyPresentation.revealSeconds
        guard enabled else {
            births = Array(repeating: now - duration - 1, count: count)
            return nil
        }
        if count < births.count { births.removeLast(births.count - count) }
        if count > births.count { births.append(contentsOf: repeatElement(now, count: count - births.count)) }
        guard births.contains(where: { now - $0 < duration }) else { return nil }
        return births.map { born in
            let progress = min(1, max(0, (now - born) / duration))
            return 1 - pow(1 - progress, 3)
        }
    }
}
