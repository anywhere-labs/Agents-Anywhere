import Foundation

extension V2SessionDetailService {
    /// Explicit export reads independently of the visible history window. A
    /// stopped cursor or interrupted read cannot masquerade as a complete export.
    func exportTimeline(sessionId: String) async throws -> SessionTimelineExport {
        let snapshot = try await load(sessionId: sessionId, itemLimit: 1)
        try Task.checkCancellation()
        guard snapshot.session.id == sessionId else { throw V2ClientFailure(kind: .unavailable, message: "会话数据不匹配，导出已停止。") }
        var items: [String: V2TimelineItem] = [:]
        var after = 0
        var bytes = 0
        while true {
            try Task.checkCancellation()
            let page = try await sessionAPI.timelineChanges(sessionId: sessionId, afterSeq: after, limit: 500)
            try Task.checkCancellation()
            guard page.sessionId == sessionId else { throw V2ClientFailure(kind: .unavailable, message: "会话数据不匹配，导出已停止。") }
            for item in page.items {
                guard item.sessionId == sessionId else { throw V2ClientFailure(kind: .unavailable, message: "会话数据不匹配，导出已停止。") }
                if let previous = items[item.id], previous.revision > item.revision { continue }
                items[item.id] = item
                bytes += item.raw.formattedJSON.utf8.count
            }
            guard items.count <= 100_000, bytes <= 64 * 1024 * 1024 else {
                throw V2ClientFailure(kind: .unavailable, message: "会话数据过大，请在 Web 中导出。")
            }
            if !page.hasMore {
                return SessionTimelineExport(source: "remote", session: snapshot.session, items: Array(items.values),
                    notices: snapshot.notices, nextSeq: page.nextSeq, hasMore: false, serverTime: page.serverTime)
            }
            guard let next = page.items.map(\.updatedSeq).max(), next > after else {
                throw V2ClientFailure(kind: .unavailable, message: "服务器未返回下一页数据，导出已停止，请重试。")
            }
            after = next
        }
    }
}
