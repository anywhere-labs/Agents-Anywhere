import Foundation

/// The ports one session's processes listen on (preview 1.0 device events).
///
/// `port.listening` carries the device's whole current list, so it replaces the
/// session's ports; `port.closed` removes one. These are device facts, not
/// timeline data: they never acknowledge or advance the session's event cursor.
nonisolated enum V3SessionPorts {
    static let listening = "port.listening"
    static let closed = "port.closed"
    /// The card shows at most this many ports.
    static let visibleLimit = 3

    static func isPortEvent(_ type: String) -> Bool { type == listening || type == closed }

    /// Returns the session's ports after `type`/`payload`. Malformed entries and
    /// other sessions' ports are skipped; an unrelated type returns `current`.
    static func apply(_ current: [Int: V3ListeningPort], type: String, payload: JSONValue,
                      sessionId: V2SessionID) -> [Int: V3ListeningPort] {
        switch type {
        case listening:
            guard case let .array(entries)? = payload["ports"] else { return [:] }
            var next: [Int: V3ListeningPort] = [:]
            for entry in entries {
                guard let port = decode(entry), (1...65535).contains(port.port), port.sessionId == sessionId else { continue }
                next[port.port] = port
            }
            return next
        case closed:
            guard let port = payload["port"]?.intValue, current[port] != nil else { return current }
            var next = current
            next[port] = nil
            return next
        default:
            return current
        }
    }

    /// Ports in display order, at most `visibleLimit`.
    static func visible(_ ports: [Int: V3ListeningPort]) -> [V3ListeningPort] {
        Array(ports.values.sorted { $0.port < $1.port }.prefix(visibleLimit))
    }

    private static func decode(_ value: JSONValue) -> V3ListeningPort? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(V3ListeningPort.self, from: data)
    }
}
