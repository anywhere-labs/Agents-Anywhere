import Foundation

struct SessionTimelineExport: Encodable {
    let source: String
    let session: V2SessionMeta
    let items: [JSONValue]
    let notices: [JSONValue]
    let nextSeq: Int
    let hasMore: Bool
    let serverTime: String?
    let exportedAt: String

    init(source: String, session: V2SessionMeta, items: [V2TimelineItem], notices: [V2RuntimeNotice],
         nextSeq: Int, hasMore: Bool, serverTime: String? = nil) {
        self.source = source; self.session = session
        self.items = items.sorted { ($0.orderSeq, $0.updatedSeq, $0.id) < ($1.orderSeq, $1.updatedSeq, $1.id) }.map(\.raw)
        self.notices = notices.map(\.raw)
        self.nextSeq = nextSeq; self.hasMore = hasMore; self.serverTime = serverTime
        exportedAt = Date().ISO8601Format()
    }
    func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}
