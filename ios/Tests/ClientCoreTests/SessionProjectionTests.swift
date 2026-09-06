import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionProjectionTests {
    @Test func allBackendSessionStatusesAndFutureStatesDecodeInMetadata() throws {
        for status in ["idle", "waiting", "pending", "running", "stopping", "waiting_approval", "error", "blocked"] {
            var raw = try fixtureObject("session")["session"] as! [String: Any]
            raw["status"] = status
            let meta: V2SessionMeta = try decode(raw)
            #expect(meta.status.rawValue == status)
        }
        var raw = try fixtureObject("session")["session"] as! [String: Any]
        raw["status"] = "future_status"; raw["connectorStatus"] = "future_presence"
        let meta: V2SessionMeta = try decode(raw)
        #expect(meta.status == .unknown && meta.connectorStatus == .unknown)
    }

    @Test func sameSequenceLiveTransitionsAreNotDeduplicated() throws {
        var projection = V2SessionProjection(snapshot: try snapshot(), maximumItems: 100)
        var state = try fixtureObject("state")["state"] as! [String: Any]
        state["status"] = "running"
        let running = try event("runtime.state.updated", id: "A", payload: ["state": state])
        state["status"] = "idle"
        let idle = try event("runtime.state.updated", id: "B", payload: ["state": state])
        try projection.apply(running); try projection.apply(idle); try projection.apply(running)
        #expect(projection.data.state?.status == .running)
        #expect(projection.data.cursor == "seq:10")
    }

    @Test func timelineUsesRevisionAndHistoryDoesNotAcknowledgeEvents() throws {
        var projection = V2SessionProjection(snapshot: try snapshot(hasMore: true), maximumItems: 3)
        let newer = try itemObject(revision: 3, seq: 11, text: "Streamed")
        let update = try event("timeline.item_updated", seq: 11, id: "once", payload: ["item": newer])
        try projection.apply(update); try projection.apply(update)
        let page = V2SessionTimelinePage(sessionId: "session", items: [try decode(itemObject(revision: 1))], nextSeq: 1000, hasMore: false, serverTime: nil)
        projection.applyHistory(page)
        #expect(projection.data.items.count == 1)
        #expect(projection.data.items[0].revision == 3)
        #expect(projection.data.cursor == "seq:11")
    }

    @Test func boundedHistoryWindowAndReturningToLatest() throws {
        let recent = try [itemObject(id: "3", order: 3), itemObject(id: "4", order: 4)]
        var projection = V2SessionProjection(snapshot: try snapshot(items: recent, hasMore: true), maximumItems: 3)
        let older = try [itemObject(id: "1", order: 1), itemObject(id: "2", order: 2)].map { try decode($0, as: V2TimelineItem.self) }
        projection.applyHistory(V2SessionTimelinePage(sessionId: "session", items: older, nextSeq: 50, hasMore: false, serverTime: nil))
        #expect(projection.data.items.map(\.id) == ["1", "2", "3"])
        #expect(projection.data.hasNewerItems)
        try projection.apply(event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "5", order: 5, seq: 11)]))
        #expect(projection.data.items.map(\.id) == ["1", "2", "3"])
        projection.applyLatest(V2SessionTimelinePage(sessionId: "session", items: try recent.map { try decode($0) }, nextSeq: 11, hasMore: true, serverTime: nil))
        #expect(projection.data.items.map(\.id) == ["3", "4"])
        #expect(!projection.data.hasNewerItems)
    }

    @Test func lateLatestPagePreservesNewerSocketChanges() throws {
        var projection = V2SessionProjection(snapshot: try snapshot(), maximumItems: 3)
        try projection.apply(event("timeline.item_updated", seq: 11, payload: ["item": itemObject(revision: 2, seq: 11)]))
        projection.applyLatest(try fixture("timeline"))
        #expect(projection.data.items[0].revision == 2)
        #expect(projection.data.cursor == "seq:11")
    }

    @Test func resetReplacesTimelineAndUnknownEventsRemainAccessible() throws {
        var projection = V2SessionProjection(snapshot: try snapshot(), maximumItems: 2)
        try projection.apply(event("timeline.snapshot", seq: 11, payload: ["items": []]))
        #expect(projection.data.items.isEmpty)
        let extensionEvent = try event("vendor.progress", seq: 12, payload: ["progress": 0.5])
        try projection.apply(extensionEvent)
        #expect(projection.data.lastExtensionEvent == extensionEvent)
        try projection.apply(event("session.subscribed", seq: 999))
        #expect(projection.data.cursor == "seq:12")
        try projection.apply(event("timeline.item_created", seq: 13, sessionID: "another", payload: ["item": itemObject()]))
        #expect(projection.data.items.isEmpty)
    }

    @Test func runtimeIdentityAndFreshnessAreSeparateFromCachedContent() throws {
        var projection = V2SessionProjection(snapshot: try snapshot(), maximumItems: 2)
        let live = V2SessionLiveState(state: try fixture("state", as: V2RuntimeStateResponse.self).state,
                                    capabilities: try fixture("capabilities", as: V2RuntimeCapabilityResponse.self).capabilitySet, notices: [])
        projection.applyLive(live)
        #expect(projection.data.liveStateIsFresh)
        var state = try fixtureObject("state")["state"] as! [String: Any]
        state["runtimeId"] = "another"
        try projection.apply(event("runtime.state.updated", payload: ["state": state]))
        #expect(projection.data.state?.runtimeId == "rti_work")
        projection.markStale()
        #expect(!projection.data.liveStateIsFresh)
        #expect(projection.data.items.count == 1)
    }
}
