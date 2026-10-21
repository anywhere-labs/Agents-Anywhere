import Foundation

struct SessionSidebarPresentation: Equatable {
    enum Indicator { case none, running, waitingApproval, unread }
    let indicator: Indicator
    let isRunning: Bool
    let sortTime: TimeInterval

    init(_ session: V2SessionMeta) {
        if session.status == .waitingApproval { indicator = .waitingApproval }
        else if [.running, .waiting, .pending].contains(session.status) { indicator = .running }
        else if session.unread && session.status == .idle { indicator = .unread }
        else { indicator = .none }
        isRunning = session.status == .running
        sortTime = V2Timestamp.seconds(session.sortAt) ?? 0
    }
    /// Builds each presentation once instead of twice per comparison.
    static func sorted(_ sessions: [V2SessionMeta]) -> [V2SessionMeta] {
        sessions.map { ($0, Self($0)) }
            .sorted { $0.1.precedes($1.1, id: $0.0.id, otherID: $1.0.id) }
            .map(\.0)
    }
    func precedes(_ other: Self, id: String, otherID: String) -> Bool {
        if isRunning != other.isRunning { return isRunning }
        if isRunning { return id < otherID }
        if sortTime != other.sortTime { return sortTime > other.sortTime }
        return id > otherID
    }
}
