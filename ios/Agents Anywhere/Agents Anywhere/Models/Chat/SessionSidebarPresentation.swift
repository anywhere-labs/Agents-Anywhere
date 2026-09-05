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
        if let raw = session.sortAt {
            let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw))
                ?? (try? Date.ISO8601FormatStyle().parse(raw))
            sortTime = date?.timeIntervalSince1970 ?? 0
        } else { sortTime = 0 }
    }
    func precedes(_ other: Self, id: String, otherID: String) -> Bool {
        if isRunning != other.isRunning { return isRunning }
        if isRunning { return id < otherID }
        if sortTime != other.sortTime { return sortTime > other.sortTime }
        return id > otherID
    }
}
