import CryptoKit
import Foundation

/// Where finished plan versions sit in the chat, and which system rows only repeat them.
enum PlanTimeline {
    struct Placement {
        var before: [String: [V2PlanDocument]] = [:]
        var end: [V2PlanDocument] = []
    }

    /// A plan sits before the first user message that followed it. An approved plan
    /// therefore lands directly above the implementation it started; one still under
    /// review has no later user message and stays at the end, beside the composer.
    static func placement(_ documents: [V2PlanDocument], groups: [ChatTimelineGroup]) -> Placement {
        let userTimes = groups.map { group in
            group.rows.filter { $0.value.role == .user }.compactMap { date($0.value.createdAt) }.min()
        }
        let ordered = documents.sorted { lhs, rhs in
            switch (date(lhs.createdAt), date(rhs.createdAt)) {
            case let (l?, r?) where l != r: return l < r
            case (_?, nil): return true
            case (nil, _?): return false
            default: return lhs.revision < rhs.revision
            }
        }
        var result = Placement()
        for document in ordered {
            guard let at = date(document.createdAt),
                  let index = userTimes.firstIndex(where: { $0.map { $0 > at } ?? false }) else {
                result.end.append(document); continue
            }
            result.before[groups[index].id, default: []].append(document)
        }
        return result
    }

    /// A system row that only repeats a plan (or its draft); the plan card shows it instead.
    static func isEcho(_ row: ChatTimelineRowModel, state: V2PlanningState?, documents: [V2PlanDocument]) -> Bool {
        guard row.value.role == .system else { return false }
        let text = row.value.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        if let draft = state?.draft?.content.trimmingCharacters(in: .whitespacesAndNewlines), !draft.isEmpty, draft.hasPrefix(text) { return true }
        // Earlier versions may arrive without their body; their hash still identifies the echo.
        let hash = contentHash(row.value.displayText)
        return documents.contains { $0.contentHash == hash || (!$0.markdown.isEmpty && $0.markdown.trimmingCharacters(in: .whitespacesAndNewlines) == text) }
    }

    static func latestRevisions(_ documents: [V2PlanDocument]) -> [String: Int] {
        documents.reduce(into: [:]) { latest, document in latest[document.planId] = max(latest[document.planId] ?? 0, document.revision) }
    }

    /// Review outcome of this exact version.
    static func status(_ state: V2PlanningState?, _ document: V2PlanDocument) -> String? {
        guard let review = state?.review, review.planId == document.planId, review.planRevision == document.revision else { return nil }
        switch review.status {
        case "approved":
            switch state?.execution?.status {
            case "started": return String(localized: "已执行")
            case "rejected": return String(localized: "已同意，执行未启动")
            default: return String(localized: "已同意")
            }
        case "open": return String(localized: "待确认")
        case "responding": return String(localized: "正在确认")
        case "revision_requested": return String(localized: "已请求修改")
        case "dismissed": return String(localized: "未执行")
        case "withdrawn": return String(localized: "已撤回")
        case "unknown": return String(localized: "结果待核对")
        default: return nil
        }
    }

    /// Same digest the Connector stores as `contentHash`.
    static func contentHash(_ text: String) -> String {
        "sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func date(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()
}
