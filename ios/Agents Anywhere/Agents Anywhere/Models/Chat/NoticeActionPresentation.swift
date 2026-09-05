import Foundation

/// Keep wire actions intact while choosing the two most useful compact actions.
/// Cancellation and rejection stay distinct; unavailable actions are never added.
struct NoticeActionPresentation {
    let direct: [V2RuntimeNoticeAction]
    let more: [V2RuntimeNoticeAction]

    init(_ actions: [V2RuntimeNoticeAction]) {
        let primary = actions.first { $0.style == "primary" }
            ?? actions.first { !["reject", "cancel", "dismiss"].contains($0.id) }
        let negative = actions.first { $0.id == "reject" }
            ?? actions.first { ["cancel", "dismiss"].contains($0.id) }
        var selected = [primary, negative].compactMap { $0 }
        if selected.isEmpty, let first = actions.first { selected = [first] }
        var seen: Set<String> = []
        direct = selected.filter { seen.insert($0.id).inserted }
        more = actions.filter { !seen.contains($0.id) }
    }
    static func title(_ action: V2RuntimeNoticeAction, notice: V2RuntimeNotice) -> String {
        switch action.id {
        case "approve": return "批准"
        case "approve_for_session": return "本会话批准"
        case "reject": return "拒绝"
        case "cancel": return notice.interactionType == "approval" ? "取消本轮" : "取消"
        case "dismiss": return "取消"
        case "submit": return "提交"
        default: return action.label
        }
    }
    static func symbol(_ action: V2RuntimeNoticeAction) -> String {
        switch action.id {
        case "reject", "cancel", "dismiss": "xmark"
        case "approve_for_session": "checkmark.shield"
        default: "checkmark"
        }
    }
}
