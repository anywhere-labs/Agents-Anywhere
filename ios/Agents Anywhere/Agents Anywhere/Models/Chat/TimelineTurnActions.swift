import Foundation

struct TimelineTurnAction {
    let replies: [ChatTimelineRowModel]
    var copyText: String {
        replies.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

enum TimelineTurnActions {
    /// Match Web: one footer after the final group between user messages. Tool
    /// results and reasoning can end a turn but never enter its copied reply.
    static func build(groups: [ChatTimelineGroup], suppressLatest: Bool, hasPendingUserMessage: Bool = false) -> [String: TimelineTurnAction] {
        var actions: [String: TimelineTurnAction] = [:]
        var replies: [ChatTimelineRowModel] = []
        var endGroupID: String?
        var turnOpen = false
        var hasActiveItems = false

        func commit() {
            if let endGroupID, !replies.isEmpty, !hasActiveItems {
                actions[endGroupID] = TimelineTurnAction(replies: replies)
            }
            replies = []; endGroupID = nil; turnOpen = false; hasActiveItems = false
        }

        for group in groups {
            if group.rows.contains(where: { $0.structure.type == .message && $0.structure.role == .user }) {
                commit()
                turnOpen = true
            }
            let messages = group.rows.filter { $0.structure.type == .message && $0.structure.role == .assistant }
            if !messages.isEmpty { turnOpen = true }
            guard turnOpen else { continue }
            endGroupID = group.id
            replies.append(contentsOf: messages)
            hasActiveItems = hasActiveItems || group.rows.contains { $0.structure.status.isActive }
        }
        // The pending user bubble already starts the next turn, even before its
        // echo enters groups. A runtime "waiting" event belongs to that new turn.
        if !suppressLatest || hasPendingUserMessage { commit() }
        return actions
    }
}
