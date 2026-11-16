import Foundation
import Testing
@testable import ClientCore

/// Protocol 1.2 offline semantics: the Server keeps no history while a session's
/// device is offline, so retained content and its cursor survive offline reads.
@Suite @MainActor struct DeviceOfflineTests {
    private func location() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("aa-offline-tests-" + UUID().uuidString) }

    private func offlineSnapshotData(cursor: String = "seq:30") throws -> Data {
        var object = try fixtureObject("snapshot")
        var meta = object["session"] as! [String: Any]; meta["connectorStatus"] = "offline"; meta["updatedSeq"] = 99
        object["session"] = meta
        object["timeline"] = ["items": [], "nextSeq": 0, "hasMore": false]
        object["eventCursor"] = cursor
        object["historySource"] = "unavailable"
        object["deviceOffline"] = true
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func repo(_ http: TestHTTPTransport, realtime: TestRealtimeAPI? = nil, local: V2LocalStore? = nil) -> V2SessionRepository {
        let runtime = V2RuntimeAPI(transport: http)
        return V2SessionRepository(
            scope: .init(serverURL: URL(string: "https://example.test")!, accountID: "account"),
            detail: .init(sessionAPI: V2SessionAPI(transport: http), runtimeAPI: runtime, realtimeAPI: realtime ?? TestRealtimeAPI()),
            interactions: .init(runtimeAPI: runtime), localStore: local,
            sleep: { _ in try await Task.sleep(for: .milliseconds(1)) })
    }

    private func offlineRecovery(cursor: String = "seq:0") -> V2EventRecoveryResponse {
        V2EventRecoveryResponse(events: [], nextCursor: cursor, snapshotRequired: false, serverTime: "", deviceOffline: true)
    }

    @Test func protocol12FieldsDecodeAndOlderServersStillDecode() throws {
        var object = try fixtureObject("event"); object["protocolVersion"] = "1.2"
        object["type"] = V2SessionEvent.catchupRequired
        object["payload"] = ["sessionId": "session", "reason": "device_reconnected"]
        let catchup: V2SessionEvent = try decode(object)
        #expect(catchup.protocolVersion == "1.2" && catchup.type == "session.catchup_required")

        let offline = try JSONDecoder().decode(V2SessionSnapshot.self, from: offlineSnapshotData())
        #expect(offline.historyUnavailable && offline.historySource == "unavailable" && offline.deviceOffline == true)
        let legacy: V2SessionSnapshot = try fixture("snapshot")
        #expect(!legacy.historyUnavailable && legacy.deviceOffline == nil)

        let page = try decode(["sessionId": "session", "items": [], "nextSeq": 0, "hasMore": false, "serverTime": "",
                               "historySource": "unavailable", "deviceOffline": true], as: V2SessionTimelinePage.self)
        #expect(page.historyUnavailable)
        var recovery = try fixtureObject("recovery"); recovery["deviceOffline"] = true
        #expect(try decode(recovery, as: V2EventRecoveryResponse.self).deviceOffline == true)
        #expect(try fixture("recovery", as: V2EventRecoveryResponse.self).deviceOffline == nil)

        var session = try fixtureObject("snapshot")["session"] as! [String: Any]
        #expect(try decode(session, as: V2SessionMeta.self).planState == nil)
        session["planState"] = "awaiting_review"; session["goalState"] = "active"
        let meta = try decode(session, as: V2SessionMeta.self)
        #expect(meta.planState == .awaitingReview && meta.goalState == .active)
        session["planState"] = "future_state"; session["goalState"] = "future_state"
        let future = try decode(session, as: V2SessionMeta.self)
        #expect(future.planState == .unknown && future.goalState == .unknown)
    }

    @Test func sessionListShowsPlanAndGoalStatesWhileTheDeviceIsOffline() throws {
        var session = try fixtureObject("snapshot")["session"] as! [String: Any]
        session["connectorStatus"] = "offline"; session["status"] = "idle"; session["unread"] = false
        session["planState"] = "awaiting_review"
        #expect(SessionSidebarPresentation(try decode(session)).indicator == .planReview)
        session["planState"] = "none"; session["goalState"] = "active"
        #expect(SessionSidebarPresentation(try decode(session)).indicator == .goalActive)
        session["goalState"] = "paused"
        #expect(SessionSidebarPresentation(try decode(session)).indicator == .goalPaused)
        session["goalState"] = "completed"
        #expect(SessionSidebarPresentation(try decode(session)).indicator == .none)
        session["status"] = "waiting_approval"; session["planState"] = "awaiting_review"
        #expect(SessionSidebarPresentation(try decode(session)).indicator == .waitingApproval)
    }

    @Test func offlineSnapshotKeepsLoadedContentCursorAndPaging() async throws {
        let http = TestHTTPTransport(); var offline = false
        http.respond = { call in
            if offline, call.path.hasSuffix("snapshot") { return try self.offlineSnapshotData() }
            if offline, call.path.hasSuffix("timeline") {
                return try JSONSerialization.data(withJSONObject: ["sessionId": "session", "items": [], "nextSeq": 0,
                    "hasMore": false, "serverTime": "", "historySource": "unavailable", "deviceOffline": true])
            }
            if call.path.hasSuffix("snapshot") {
                var object = try fixtureObject("snapshot")
                var timeline = object["timeline"] as! [String: Any]; timeline["hasMore"] = true; object["timeline"] = timeline
                return try JSONSerialization.data(withJSONObject: object)
            }
            return try http.defaultResponse(call)
        }
        let repo = repo(http); defer { repo.reset() }
        let loaded = try await repo.load(sessionId: "session")
        #expect(loaded.items.count == 1 && loaded.cursor == "seq:10" && loaded.hasOlderItems)
        offline = true
        let refreshed = try await repo.refresh(sessionId: "session")
        #expect(refreshed.items.map(\.id) == loaded.items.map(\.id))
        #expect(refreshed.cursor == "seq:10", "An offline snapshot must not move the recovery cursor")
        #expect(refreshed.hasOlderItems, "An empty offline page is not the start of the history")
        #expect(refreshed.historyUnavailable && refreshed.session.connectorStatus == .offline)
        #expect(repo.session(id: "session").historyUnavailable)
        // No automatic paging while the device cannot serve history.
        let timelineReads = http.count("timeline")
        let older = try await repo.loadOlder(sessionId: "session")
        #expect(http.count("timeline") == timelineReads && older.items.count == 1 && older.hasOlderItems)
        // An offline latest page does not replace the retained window either.
        let latest = try await repo.loadLatest(sessionId: "session")
        #expect(latest.items.count == 1 && latest.cursor == "seq:10")
    }

    @Test func offlineSnapshotOverDiskCacheKeepsTheArchiveAndCursor() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let store = V2LocalStore(directory: url)
        let first = repo(TestHTTPTransport(), local: store)
        _ = try await first.load(sessionId: "session"); await first.flushCache(); first.reset()

        let http = TestHTTPTransport()
        http.respond = { call in call.path.hasSuffix("snapshot") ? try self.offlineSnapshotData() : try http.defaultResponse(call) }
        let restored = repo(http, local: store); defer { restored.reset() }
        let cached = try await restored.load(sessionId: "session")
        #expect(cached.items.count == 1 && http.count("snapshot") == 0)
        let offline = try await restored.refresh(sessionId: "session")
        #expect(offline.items.count == 1 && offline.cursor == "seq:10" && offline.historyUnavailable)
        await restored.flushCache()
        let archive = try #require(await store.session("session"))
        #expect(archive.items.count == 1 && archive.cursor == "seq:10" && archive.baseline == nil)
        await store.close(removing: true)
    }

    @Test func offlineEmptySnapshotIsNotWrittenToDisk() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let store = V2LocalStore(directory: url)
        let http = TestHTTPTransport()
        http.respond = { call in call.path.hasSuffix("snapshot") ? try self.offlineSnapshotData() : try http.defaultResponse(call) }
        let first = repo(http, local: store)
        let data = try await first.load(sessionId: "session")
        #expect(data.items.isEmpty && data.cursor == "seq:0" && !data.hasBaseline && data.historyUnavailable)
        await first.flushCache()
        #expect(await store.session("session") == nil, "An offline empty snapshot is not an authoritative base")
        // A draft is still kept, without timeline or cursor, and is not a base on restore.
        first.session(id: "session").draft = "离线时写的草稿"
        first.draftDidChange(sessionID: "session")
        await first.flushCache(); first.reset()
        let archive = try #require(await store.session("session"))
        #expect(archive.items.isEmpty && archive.cursor == "seq:0" && archive.baseline == false)
        let restored = repo(TestHTTPTransport(), local: store); defer { restored.reset() }
        restored.updateConnectivity(.init(availability: .offline))
        let value = try await restored.load(sessionId: "session")
        #expect(!value.hasBaseline && restored.session(id: "session").draft == "离线时写的草稿")
        await store.close(removing: true)
    }

    @Test func catchupRecoversFromTheClientsOwnCursor() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repo(http, realtime: realtime); defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.connection == .connected }
        #expect(realtime.recoveries == ["seq:10"])
        realtime.onRecover = { try fixture("recovery") }
        // The catch-up frame carries the device's head, not a cursor to acknowledge.
        realtime.yield(try event(V2SessionEvent.catchupRequired, seq: 99,
            payload: ["sessionId": "session", "reason": "device_reconnected"]))
        try await eventually { model.timeline.count == 2 }
        #expect(realtime.recoveries == ["seq:10", "seq:10"])
        #expect(repo.cached(sessionId: "session")?.cursor == "seq:11")
    }

    @Test func liveItemWhileHistoryUnavailableRecoversTheGapFirst() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        realtime.onRecover = { self.offlineRecovery() }
        let repo = repo(http, realtime: realtime); defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.connection == .connected }
        #expect(model.historyUnavailable && repo.cached(sessionId: "session")?.cursor == "seq:10")
        // The device returns: its first live item (seq 12) must not skip seq 11.
        realtime.onRecover = { try fixture("recovery") }
        realtime.yield(try event("timeline.item_created", seq: 12,
            payload: ["item": itemObject(id: "item-3", order: 3, seq: 12)]))
        try await eventually { model.timeline.count == 3 }
        #expect(model.timeline.map(\.id) == ["item", "item-2", "item-3"])
        #expect(!model.historyUnavailable && repo.cached(sessionId: "session")?.cursor == "seq:12")
        #expect(realtime.recoveries == ["seq:10", "seq:10"])
    }

    @Test func deviceReturningAfterAnOfflineFirstReadLoadsASnapshot() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI(); var online = false
        http.respond = { call in
            call.path.hasSuffix("snapshot") && !online ? try self.offlineSnapshotData() : try http.defaultResponse(call)
        }
        realtime.onRecover = { self.offlineRecovery() }
        let repo = repo(http, realtime: realtime); defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.connection == .connected }
        #expect(model.timeline.isEmpty && model.historyUnavailable && realtime.recoveries == ["seq:0"])
        online = true
        realtime.onRecover = { V2EventRecoveryResponse(events: [], nextCursor: "seq:0", snapshotRequired: false, serverTime: "") }
        realtime.yield(try event(V2SessionEvent.catchupRequired, seq: 10,
            payload: ["sessionId": "session", "reason": "device_reconnected"]))
        try await eventually { model.timeline.count == 1 }
        let data = try #require(repo.cached(sessionId: "session"))
        #expect(data.hasBaseline && !data.historyUnavailable && data.cursor == "seq:10")
        #expect(http.count("snapshot") == 2)
    }

    @Test func catchupDuringARecoveryReadsOnceMoreAfterIt() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repo(http, realtime: realtime); defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.connection == .connected }
        let gate = TestGate()
        realtime.onRecover = {
            await gate.wait()
            return V2EventRecoveryResponse(events: [], nextCursor: "seq:10", snapshotRequired: false, serverTime: "")
        }
        let sync = Task { try await repo.sync(sessionId: "session") }
        try await eventually { realtime.recoveries.count == 2 }
        realtime.yield(try event(V2SessionEvent.catchupRequired, seq: 10,
            payload: ["sessionId": "session", "reason": "device_reconnected"]))
        for _ in 0..<20 { await Task.yield() }
        #expect(realtime.recoveries.count == 2, "The request joins the read in progress")
        gate.release()
        try await sync.value
        try await eventually { realtime.recoveries.count == 3 }
    }

    @Test func outcomeUnknownIsNeverADefiniteRejection() {
        for status in [409, 502, 504] {
            let error = HTTPError.server(statusCode: status, message: "unknown", detail: .object(["code": .string("command_outcome_unknown")]))
            #expect(!V2ClientFailure.isDefiniteWriteRejection(error))
            #expect(!V2ClientFailure.isDefiniteWriteRejection(V2ClientFailure(error)))
            #expect(V2ClientFailure(error).isOutcomeUnknown && V2ClientFailure(error).kind != .rejected)
        }
        let offline = HTTPError.server(statusCode: 409, message: "offline", detail: .object(["code": .string("connector_offline")]))
        #expect(V2ClientFailure.isDefiniteWriteRejection(offline))
        #expect(RuntimeErrorText.text(code: "command_outcome_unknown") != nil)
        for code in ["device_read_timeout", "share_requires_online_device", "codex_owner_unavailable", "e2ee_required",
                     "e2ee_not_paired", "pairing_expired", "device_pin_mismatch"] {
            #expect(RuntimeErrorText.text(code: code) != nil, "Missing text for \(code)")
        }
    }

    @Test func signingOutDeletesTheAccountCacheAndClosingPagesCannotWriteBack() async throws {
        let root = location(); defer { try? FileManager.default.removeItem(at: root) }
        let services = V2ClientServices(api: V2APIClient(serverURL: URL(string: "http://127.0.0.1:1")!,
            tokenProvider: StaticAuthTokenProvider(token: nil)), accountID: "signed-in", offlineRoot: root)
        let directory = root.appendingPathComponent(services.offlineScopeKey)
        let source = repo(TestHTTPTransport())
        let data = try await source.load(sessionId: "session")
        let page = services.sessionRepository.session(id: "session")
        page.draft = "draft"
        let archive = V2SessionArchive(data: data, model: page)
        await services.localStore.saveSession(archive)
        #expect(FileManager.default.fileExists(atPath: directory.path))

        services.shutdown(removingCache: true)
        // A page that is still closing tries to write its session back.
        await services.localStore.saveSession(archive)
        services.sessionRepository.draftDidChange(sessionID: "session")
        await services.sessionRepository.flushCache()
        try await eventually { !FileManager.default.fileExists(atPath: directory.path) }
        await services.localStore.saveSession(archive)
        #expect(!FileManager.default.fileExists(atPath: directory.path))
        #expect(await services.localStore.session("session") == nil)
        #expect(!page.isValid && page.draft.isEmpty)
        source.reset()
    }

    @Test func signingInKeepsOnlyTheCurrentAccountsOfflineContent() throws {
        let root = location(); defer { try? FileManager.default.removeItem(at: root) }
        for name in ["current", "previous", "other-server"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        V2LocalStore.removeScopes(in: root, keeping: "current")
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == ["current"])
        V2LocalStore.removeScopes(in: root, keeping: nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
}
