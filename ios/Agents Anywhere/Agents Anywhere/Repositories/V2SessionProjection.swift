import Foundation

/// Reduces server projections without network I/O or UI state. Live projections may
/// change A -> B -> A at the same durable sequence and must not use event-ID dedup.
struct V2SessionProjection {
    private(set) var data: V2SessionData
    private let maximumItems: Int
    private var eventIDs: Set<String> = []
    private var eventOrder: [String] = []
    private let decoder = JSONDecoder()

    init(snapshot: V2SessionSnapshot, maximumItems: Int) {
        data = V2SessionData(snapshot: snapshot)
        self.maximumItems = max(1, maximumItems)
        replaceTimeline(snapshot.timeline.items, hasMore: snapshot.timeline.hasMore)
    }

    var sequence: Int { Self.sequence(data.cursor) }

    static func sequence(_ cursor: String) -> Int {
        Int(cursor.dropFirst(4)) ?? 0
    }

    mutating func advanceCursor(_ cursor: String) {
        if Self.sequence(cursor) > sequence { data.cursor = cursor }
    }

    mutating func markStale() { data.liveStateIsFresh = false }

    mutating func applyLive(_ live: V2SessionLiveState) {
        guard live.state.sessionId == data.session.id,
              (live.state.runtimeId ?? live.state.runtime) == data.session.effectiveRuntimeId else { return }
        data.state = live.state
        data.capabilities = live.capabilities
        data.notices = live.notices
        data.liveStateIsFresh = data.session.connectorStatus == .online
    }

    mutating func applyMeta(_ session: V2SessionMeta) {
        guard session.id == data.session.id, session.updatedSeq >= data.session.updatedSeq else { return }
        let changedRuntime = session.effectiveRuntimeId != data.session.effectiveRuntimeId
        data.session = session
        if changedRuntime || session.connectorStatus != .online { markStale() }
    }

    mutating func applyState(_ state: V2RuntimeState) {
        guard state.sessionId == data.session.id,
              (state.runtimeId ?? state.runtime) == data.session.effectiveRuntimeId else { return }
        data.state = state
    }

    mutating func apply(_ event: V2SessionEvent) throws {
        guard event.sessionId == data.session.id else { return }
        guard event.sequence >= sequence else { return }
        if !event.isLiveProjection, eventIDs.contains(event.eventId) { return }
        switch event.type {
        case "session.meta.updated":
            applyMeta(try payload("session", in: event))
        case "runtime.state.updated":
            applyState(try payload("state", in: event))
        case "runtime.capability.updated":
            data.capabilities = try payload("capabilitySet", in: event)
        case "timeline.item_created", "timeline.item_updated":
            merge([try payload("item", in: event)], history: false)
        case "timeline.snapshot":
            let items: [V2TimelineItem] = try payload("items", in: event)
            replaceTimeline(items, hasMore: false)
        case "runtime.notice.snapshot":
            data.notices = try payload("notices", in: event)
        case "runtime.notice.updated":
            let notice: V2RuntimeNotice = try payload("notice", in: event)
            guard notice.sessionId == data.session.id else { return }
            if let index = data.notices.firstIndex(where: { $0.id == notice.id }) {
                if notice.revision >= data.notices[index].revision { data.notices[index] = notice }
            } else {
                data.notices.append(notice)
            }
        case "runtime.catalog.updated":
            break // Catalog reads are independently cached and invalidated by the repository.
        case "session.subscribed", "session.refetch_required":
            return // These are recovery signals, never cursor acknowledgements.
        default:
            data.lastExtensionEvent = event
        }
        advanceCursor(event.cursor)
        if !event.isLiveProjection {
            eventIDs.insert(event.eventId)
            eventOrder.append(event.eventId)
            if eventOrder.count > 2048 { eventIDs.remove(eventOrder.removeFirst()) }
        }
    }

    mutating func applyHistory(_ page: V2SessionTimelinePage) {
        guard page.sessionId == data.session.id else { return }
        merge(page.items, history: true)
        data.hasOlderItems = page.hasMore
        // nextSeq is the server high watermark, not proof that intervening events were read.
    }

    mutating func applyLatest(_ page: V2SessionTimelinePage) {
        guard page.sessionId == data.session.id else { return }
        // A GET can finish after newer socket frames. Its high watermark bounds
        // the window it may replace, but never acknowledges the event cursor.
        let newer = data.items.filter { $0.updatedSeq > page.nextSeq }
        replaceTimeline(page.items, hasMore: page.hasMore)
        merge(newer, history: false)
    }

    private mutating func replaceTimeline(_ items: [V2TimelineItem], hasMore: Bool) {
        data.items = []
        data.hasNewerItems = false
        data.hasOlderItems = hasMore
        merge(items, history: false)
    }

    private mutating func merge(_ incoming: [V2TimelineItem], history: Bool) {
        var byID = Dictionary(uniqueKeysWithValues: data.items.map { ($0.id, $0) })
        let end = data.items.last?.orderSeq ?? 0
        for item in incoming where item.sessionId == data.session.id {
            if let old = byID[item.id] {
                guard item.revision > old.revision || (item.revision == old.revision && item.updatedSeq >= old.updatedSeq) else { continue }
            } else if !history, data.hasNewerItems, item.orderSeq > end {
                continue // Preserve the history window until the caller explicitly loads latest.
            }
            byID[item.id] = item
        }
        let sorted = byID.values.sorted { ($0.orderSeq, $0.id) < ($1.orderSeq, $1.id) }
        if history {
            data.items = Array(sorted.prefix(maximumItems))
            data.hasNewerItems = data.hasNewerItems || sorted.count > maximumItems
        } else {
            data.items = Array(sorted.suffix(maximumItems))
            data.hasOlderItems = data.hasOlderItems || sorted.count > maximumItems
        }
    }

    private func payload<Value: Decodable>(_ key: String, in event: V2SessionEvent) throws -> Value {
        guard let raw = event.payload[key] else {
            throw HTTPError.decoding(message: "Missing '\(key)' in \(event.type).")
        }
        do { return try decoder.decode(Value.self, from: JSONEncoder().encode(raw)) }
        catch let error as DecodingError {
            throw HTTPError.decoding(message: "\(event.type) · \(key): \(error.v2Description)")
        }
    }
}
