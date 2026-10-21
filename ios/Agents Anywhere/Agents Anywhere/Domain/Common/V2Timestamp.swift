import Foundation
import Synchronization

/// Wire timestamps are compared on every sidebar sort and dashboard tick. The
/// server repeats the same strings across pushes, so each distinct value is
/// parsed once; the format styles are built once instead of per comparison.
nonisolated enum V2Timestamp {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()
    private static let cache = Mutex<[String: TimeInterval]>([:])
    private static let capacity = 4096

    /// Seconds since 1970, or nil when the value is missing or not ISO 8601.
    static func seconds(_ raw: String?) -> TimeInterval? {
        guard let raw, !raw.isEmpty else { return nil }
        if let cached = cache.withLock({ $0[raw] }) { return cached.isNaN ? nil : cached }
        let parsed = (try? fractional.parse(raw)) ?? (try? plain.parse(raw))
        let value = parsed?.timeIntervalSince1970 ?? .nan
        cache.withLock { store in
            if store.count >= capacity { store.removeAll(keepingCapacity: true) }
            store[raw] = value
        }
        return parsed == nil ? nil : value
    }

    static func date(_ raw: String?) -> Date? {
        seconds(raw).map { Date(timeIntervalSince1970: $0) }
    }
}
