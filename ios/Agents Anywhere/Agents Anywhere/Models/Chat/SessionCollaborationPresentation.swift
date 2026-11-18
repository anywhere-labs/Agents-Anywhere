import Foundation

/// Titles of the sessions the dashboard lists, keyed by id. Collaboration labels
/// resolve their peers here; a session outside the list cannot be opened.
struct SessionCollaborationDirectory: Equatable {
    private let titles: [V2SessionID: String]

    init(sessions: [V2SessionMeta]) {
        var titles: [V2SessionID: String] = [:]
        for session in sessions { titles[session.id] = session.title ?? "" }
        self.titles = titles
    }

    static let empty = Self(sessions: [])

    func contains(_ id: V2SessionID) -> Bool { titles[id] != nil }

    /// The listed title; untitled listed sessions read 「未命名会话」, unknown ones 「另一个会话」.
    func title(_ id: V2SessionID?) -> String {
        guard let id, let title = titles[id] else { return String(localized: "另一个会话") }
        return title.isEmpty ? String(localized: "未命名会话") : title
    }
}

/// One header badge of a session page: who created it, or who supervises it.
struct SessionCollaborationBadge: Identifiable, Hashable {
    enum Kind: Hashable { case createdBy, supervisedBy(V2SupervisionState) }
    let kind: Kind
    let sessionId: V2SessionID
    let label: String
    let canOpen: Bool
    var id: String {
        switch kind {
        case .createdBy: "origin:\(sessionId)"
        case .supervisedBy: "supervisor:\(sessionId)"
        }
    }
}

enum SessionCollaborationPresentation {
    /// Small marks shown on a session list row.
    struct ListIndicator: Equatable {
        let agentCreated: Bool
        let supervised: Bool
        var isEmpty: Bool { !agentCreated && !supervised }
    }

    static func indicator(for session: V2SessionMeta) -> ListIndicator {
        ListIndicator(agentCreated: session.origin?.agentSessionId != nil,
            supervised: supervisorEdges(session).contains { $0.state == .active || $0.state == .paused })
    }

    static func badges(for session: V2SessionMeta, directory: SessionCollaborationDirectory) -> [SessionCollaborationBadge] {
        var badges: [SessionCollaborationBadge] = []
        if let creator = session.origin?.agentSessionId, creator != session.id {
            badges.append(.init(kind: .createdBy, sessionId: creator,
                label: String(localized: "由 \(directory.title(creator)) 创建"), canOpen: directory.contains(creator)))
        }
        for edge in supervisorEdges(session) where edge.supervisorSessionId != session.id {
            let name = directory.title(edge.supervisorSessionId)
            let label = switch edge.state {
            case .paused: String(localized: "被 \(name) 监督（已暂停）")
            case .ended: String(localized: "被 \(name) 监督（已结束）")
            default: String(localized: "被 \(name) 监督")
            }
            badges.append(.init(kind: .supervisedBy(edge.state), sessionId: edge.supervisorSessionId,
                label: label, canOpen: directory.contains(edge.supervisorSessionId)))
        }
        return badges
    }

    /// Valid supervisor edges targeting this session, one per supervisor
    /// (active before paused before ended), in wire order.
    static func supervisorEdges(_ session: V2SessionMeta) -> [V2SupervisionEdge] {
        let rank: [V2SupervisionState: Int] = [.active: 0, .paused: 1, .ended: 2]
        var best: [V2SessionID: V2SupervisionEdge] = [:]
        var order: [V2SessionID] = []
        for edge in session.supervisors ?? [] where edge.isValid && edge.targetSessionId == session.id {
            if let existing = best[edge.supervisorSessionId] {
                if rank[edge.state, default: 3] < rank[existing.state, default: 3] { best[edge.supervisorSessionId] = edge }
            } else {
                best[edge.supervisorSessionId] = edge; order.append(edge.supervisorSessionId)
            }
        }
        return order.compactMap { best[$0] }
    }

    /// Chinese label of a collaboration tool; nil for tools this client does not know.
    static func toolLabel(_ tool: String) -> String? {
        switch tool {
        case "aa_spawn": String(localized: "新建会话")
        case "aa_send": String(localized: "发消息")
        case "aa_steer": String(localized: "纠偏")
        case "aa_interrupt": String(localized: "打断")
        case "aa_status": String(localized: "查看状态")
        case "aa_read": String(localized: "查看进展")
        case "aa_wait": String(localized: "等待")
        case "aa_respond": String(localized: "代答审批")
        case "aa_plan_review": String(localized: "审阅计划")
        case "aa_supervise": String(localized: "开始监督")
        case "aa_unsupervise": String(localized: "停止监督")
        case "aa_escalate": String(localized: "交给人决定")
        case "aa_close": String(localized: "关闭会话")
        default: nil
        }
    }

    /// Label under a user message an Agent sent; nil for other messages.
    static func agentAuthorLabel(_ author: V2MessageAuthor?, directory: SessionCollaborationDirectory) -> String? {
        guard let author, author.kind == .agent else { return nil }
        return String(localized: "由 \(directory.title(author.sessionId)) 的 Agent 发送")
    }
}
