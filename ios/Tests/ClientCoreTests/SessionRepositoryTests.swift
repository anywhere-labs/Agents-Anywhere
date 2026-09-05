import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionRepositoryTests {
    @Test func concurrentLoadsShareRequestAndSessionIdentity() async throws {
        let http = TestHTTPTransport(); let gate = TestGate()
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let repo = repository(transport: http)
        defer { repo.reset() }
        let model = repo.session(id: "session")
        let first = Task { try await repo.load(sessionId: "session") }
        let second = Task { try await repo.load(sessionId: "session") }
        try await eventually { http.count("snapshot") == 1 }
        gate.release()
        _ = try await first.value; _ = try await second.value
        #expect(http.count("snapshot") == 1)
        #expect(repo.session(id: "session") === model)
        #expect(model.timeline.count == 1)
        #expect(!model.runtime.isFresh)
    }

    @Test func observersShareSocketRecoverAfterSubscribeAndKeepRowIdentity() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session")
        let one = Task { await model.connect() }; let two = Task { await model.connect() }
        defer { one.cancel(); two.cancel() }
        try await eventually { model.connection == .connected }
        #expect(realtime.tickets == 1)
        #expect(realtime.recoveries == ["seq:10"])
        #expect(model.canSend)
        let row = try #require(model.timeline.first)
        realtime.yield(try event("timeline.item_updated", seq: 11, payload: ["item": itemObject(revision: 2, seq: 11)]))
        try await eventually { row.value.revision == 2 }
        #expect(model.timeline.first === row)
        one.cancel(); _ = await one.result
        #expect(model.connection == .connected)
        two.cancel(); _ = await two.result
        try await eventually { model.connection == .inactive }
        #expect(!model.runtime.isFresh)
    }

    @Test func offlineRetainsDataAndDraftThenReconnectsWithFreshTicketAndCursor() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { model.connection == .connected }
        model.draft = "Unsent"
        realtime.yield(try event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "second", order: 2, seq: 11)]))
        try await eventually { model.timeline.count == 2 }
        repo.updateConnectivity(V2NetworkStatus(availability: .offline))
        #expect(model.connection == .offline)
        #expect(model.timeline.count == 2)
        #expect(!model.canSend)
        #expect(model.draft == "Unsent")
        #expect(await model.sendDraft() == nil)
        _ = try await repo.load(sessionId: "session")
        #expect(http.count("snapshot") == 1)
        repo.updateConnectivity(V2NetworkStatus(availability: .online, isExpensive: true, isConstrained: true))
        try await eventually { model.connection == .connected }
        #expect(realtime.tickets == 2)
        #expect(realtime.recoveries.last == "seq:11")
        #expect(model.canSend)
        #expect(model.network.isConstrained)
        #expect(http.count("messages") == 0)
    }

    @Test func suspendRetainsObserversAndResumesRecovery() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { model.connection == .connected }
        repo.suspend()
        #expect(model.connection == .inactive)
        #expect(model.timeline.count == 1)
        repo.resume()
        try await eventually { model.connection == .connected }
        #expect(realtime.tickets == 2)
    }

    @Test func resetRejectsLateResponsesAndClearsRetainedObjects() async throws {
        let http = TestHTTPTransport(); let gate = TestGate()
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let repo = repository(transport: http)
        let model = repo.session(id: "session"); model.draft = "Private draft"
        let load = Task { try await repo.load(sessionId: "session") }
        try await eventually { http.count("snapshot") == 1 }
        repo.reset(); gate.release()
        if case .success = await load.result { Issue.record("Old account request populated a reset cache") }
        #expect(repo.cachedSessionIDs.isEmpty)
        #expect(!model.isValid)
        #expect(model.draft.isEmpty)
        #expect(model.metadata == nil)
    }

    @Test func lruEvictsInactiveSessionsButProtectsLocalWork() throws {
        let repo = repository(transport: TestHTTPTransport(), policy: V2SessionCachePolicy(maximumSessions: 2))
        defer { repo.reset() }
        let one = repo.session(id: "one"); one.draft = "Keep me"
        let two = repo.session(id: "two")
        _ = repo.session(id: "three")
        #expect(repo.cachedSessionIDs == ["one", "three"])
        #expect(one.isValid)
        #expect(!two.isValid)
    }

    @Test func catalogReadsCoalesceExpireAndInvalidateOnNetworkLoss() async throws {
        let http = TestHTTPTransport(); var date = Date()
        let repo = repository(transport: http, now: { date })
        defer { repo.reset() }
        async let one = repo.catalogs(sessionId: "session")
        async let two = repo.catalogs(sessionId: "session")
        _ = try await (one, two)
        #expect(http.count("catalogs/model") == 1)
        _ = try await repo.catalogs(sessionId: "session")
        #expect(http.count("catalogs/model") == 1)
        date += 31
        _ = try await repo.catalogs(sessionId: "session")
        #expect(http.count("catalogs/model") == 2)
        repo.updateConnectivity(V2NetworkStatus(availability: .offline))
        do { _ = try await repo.catalogs(sessionId: "session"); Issue.record("Offline catalog was considered fresh") }
        catch { #expect((error as? V2ClientFailure)?.kind == .offline) }
        repo.updateConnectivity(V2NetworkStatus(availability: .online))
        _ = try await repo.catalogs(sessionId: "session")
        #expect(http.count("catalogs/model") == 3)
    }

    @Test func snapshotRequiredMayRewindCursorAndThenRefreshLiveFacts() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { model.connection == .connected }
        realtime.yield(try event("vendor.updated", seq: 11))
        try await eventually { repo.cached(sessionId: "session")?.cursor == "seq:11" }
        realtime.onRecover = { V2EventRecoveryResponse(events: [], nextCursor: "seq:4", snapshotRequired: true, serverTime: "") }
        http.respond = { call in
            if call.path.hasSuffix("snapshot") {
                var object = try fixtureObject("snapshot"); object["eventCursor"] = "seq:4"
                return try JSONSerialization.data(withJSONObject: object)
            }
            return try http.defaultResponse(call)
        }
        realtime.yield(try event("session.refetch_required", seq: 12))
        try await eventually { repo.cached(sessionId: "session")?.cursor == "seq:4" }
        try await eventually { model.runtime.isFresh }
        #expect(http.count("snapshot") == 2)
    }

    @Test func pendingSendTimeoutKeepsDraftAndDoesNotReplayThenEchoConfirms() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { model.canSend }
        http.respond = { call in
            if call.path.hasSuffix("messages") { throw URLError(.timedOut) }
            return try http.defaultResponse(call)
        }
        model.draft = "Hello again"
        let pending = try #require(await model.sendDraft())
        if case .uncertain = pending.delivery {} else { Issue.record("Timeout must leave delivery uncertain") }
        #expect(model.draft == "Hello again")
        #expect(await model.sendDraft() == nil)
        #expect(http.count("messages") == 1)
        realtime.yield(try event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "echo", order: 2, seq: 11, clientID: pending.id)]))
        try await eventually { pending.delivery == .confirmed }
        #expect(model.draft.isEmpty)
        #expect(model.pendingMessages.isEmpty)
        #expect(http.count("snapshot") == 1)
    }

    @Test func echoBeforeHTTPFailureWinsAndConcurrentDraftEditsSurvive() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI(); let gate = TestGate()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.canSend }
        http.respond = { call in
            if call.path.hasSuffix("messages") { await gate.wait(); throw URLError(.networkConnectionLost) }
            return try http.defaultResponse(call)
        }
        model.draft = "First"
        let send = Task { await model.sendDraft() }
        try await eventually { http.count("messages") == 1 }
        let pending = try #require(model.pendingMessages.first)
        model.draft = "Next thought"
        realtime.yield(try event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "echo", order: 2, seq: 11, clientID: pending.id)]))
        try await eventually { pending.delivery == .confirmed }
        gate.release(); _ = await send.value
        #expect(pending.delivery == .confirmed)
        #expect(model.draft == "Next thought")
    }

    @Test func liveReadFailureNeverEnablesControlsAndAuthFailureStopsReconnect() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        http.respond = { call in
            if call.path.hasSuffix("/state") { throw HTTPError.server(statusCode: 401, message: "Expired") }
            return try http.defaultResponse(call)
        }
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { model.failure?.kind == .authentication }
        #expect(!model.canSend)
        #expect(model.timeline.count == 1)
        #expect(realtime.tickets == 1)
        #expect(model.connection == .failed("Expired"))
    }

    @Test func catalogInvalidationRejectsLateInflightResponse() async throws {
        let http = TestHTTPTransport(); let gate = TestGate()
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let repo = repository(transport: http)
        defer { repo.reset() }
        let old = Task { try await repo.catalogs(sessionId: "session") }
        try await eventually { http.count("catalogs/model") == 1 }
        repo.updateConnectivity(V2NetworkStatus(availability: .offline))
        gate.release()
        if case .success = await old.result { Issue.record("An invalidated catalog read succeeded") }
        repo.updateConnectivity(V2NetworkStatus(availability: .online))
        _ = try await repo.catalogs(sessionId: "session")
        #expect(http.count("catalogs/model") == 2)
    }

    @Test func metadataBufferedBeforeLiveReadStillApplies() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI(); let gate = TestGate()
        realtime.onRecover = {
            await gate.wait()
            return V2EventRecoveryResponse(events: [], nextCursor: "seq:10", snapshotRequired: false, serverTime: "")
        }
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { realtime.recoveries.count == 1 }
        var meta = try fixtureObject("session")["session"] as! [String: Any]
        meta["title"] = "Renamed during recovery"
        realtime.yield(try event("session.meta.updated", payload: ["session": meta]))
        gate.release()
        try await eventually { model.metadata?.title == "Renamed during recovery" }
        #expect(model.canSend)
    }

    @Test func historyRequestCannotOverwriteANewerTimelineReset() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI(); let gate = TestGate()
        http.respond = { call in
            if call.path.hasSuffix("snapshot") {
                var value = try fixtureObject("snapshot")
                var timeline = value["timeline"] as! [String: Any]; timeline["hasMore"] = true; value["timeline"] = timeline
                return try JSONSerialization.data(withJSONObject: value)
            }
            if call.path.hasSuffix("timeline") { await gate.wait() }
            return try http.defaultResponse(call)
        }
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let task = Task { await model.connect() }
        defer { task.cancel() }
        try await eventually { model.canSend }
        let history = Task { try await repo.loadOlder(sessionId: "session") }
        try await eventually { http.count("timeline") == 1 }
        realtime.yield(try event("timeline.snapshot", seq: 11, payload: ["items": []]))
        try await eventually { model.timeline.isEmpty }
        gate.release()
        if case .success = await history.result { Issue.record("An older history page survived timeline reset") }
        #expect(model.timeline.isEmpty)
        #expect(repo.cached(sessionId: "session")?.cursor == "seq:11")
    }

    @Test func rejectedRuntimeActionDoesNotLookLikeSuccessfulSend() async throws {
        let http = TestHTTPTransport()
        http.respond = { _ in try fixtureData("rpcError") }
        let repo = repository(transport: http)
        defer { repo.reset() }
        do {
            _ = try await repo.send(sessionId: "session", content: "Hello", clientMessageID: "client")
            Issue.record("RPC ok:false was ignored")
        } catch { #expect((error as? V2RuntimeError)?.code == "notice_not_found") }
        #expect(http.count("messages") == 1)
        #expect(http.count("snapshot") == 0)
    }
}
