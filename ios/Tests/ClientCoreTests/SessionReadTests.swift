import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionReadTests {
    private func session(_ id: String = "session", seq: Int = 10, end: Int = 10,
                         read: Int = 0, status: String = "idle") throws -> V2SessionMeta {
        var value = try fixtureObject("session")["session"] as! [String: Any]
        value["id"] = id; value["updatedSeq"] = seq; value["latestTurnEndSeq"] = end
        value["lastReadSeq"] = read; value["unread"] = end > read; value["status"] = status
        return try decode(value)
    }

    @Test func openingClearsImmediatelyAndNavigationCannotCancelTheReceipt() async throws {
        let old = try session(), receipt = try session(read: 10), gate = TestGate()
        var calls = 0, changes = 0
        let reads = V2SessionReadCoordinator { _ in
            calls += 1
            await gate.wait()
            try Task.checkCancellation()
            return receipt
        }
        defer { reads.invalidate(); gate.release() }
        reads.onChange = { _ in changes += 1 }
        #expect(reads.ingest(old).unread)
        reads.setVisibleSession(old.id)
        #expect(!reads.project(old).unread && changes == 1)
        // Close the drawer/change selection before the worker's first actor turn.
        reads.setVisibleSession(nil)
        try await eventually { calls == 1 }
        reads.setVisibleSession(old.id)
        reads.setVisibleSession(nil)
        gate.release()
        try await eventually { changes == 2 }
        #expect(calls == 1 && !reads.ingest(old).unread)
    }

    @Test func sameRevisionSnapshotsAndOlderReceiptsCannotUndoReadOrRuntimeState() async throws {
        let old = try session(), receipt = try session(read: 10), gate = TestGate()
        var calls = 0, changes = 0
        let reads = V2SessionReadCoordinator { _ in calls += 1; await gate.wait(); return receipt }
        defer { reads.invalidate(); gate.release() }
        reads.onChange = { _ in changes += 1 }
        _ = reads.ingest(old)
        reads.setVisibleSession(old.id)
        try await eventually { calls == 1 }
        reads.setVisibleSession(nil)
        let approval = try session(seq: 12, status: "waiting_approval")
        #expect(reads.ingest(approval).status == .waitingApproval)
        gate.release()
        try await eventually { changes == 2 }
        #expect(!reads.ingest(old).unread)
        let current = reads.project(approval)
        #expect(!current.unread && current.lastReadSeq == 10)
        #expect(current.updatedSeq == 12 && current.status == .waitingApproval)
        #expect(reads.ingest(try session(seq: 20, end: 20)).unread)
        #expect(reads.ingest(old).unread, "An old snapshot cannot hide a newer unseen turn")
    }

    @Test func aNewTurnWhileVisibleQueuesOneReceiptWithoutPerTokenWrites() async throws {
        let first = try session(), next = try session(seq: 20, end: 20)
        let firstReceipt = try session(read: 10), nextReceipt = try session(seq: 20, end: 20, read: 20)
        let gate = TestGate()
        var calls = 0
        let reads = V2SessionReadCoordinator { _ in
            calls += 1
            if calls == 1 { await gate.wait(); return firstReceipt }
            return nextReceipt
        }
        defer { reads.invalidate(); gate.release() }
        _ = reads.ingest(first)
        reads.setVisibleSession(first.id)
        try await eventually { calls == 1 }
        #expect(!reads.ingest(next).unread)
        for seq in 21...30 {
            #expect(!reads.ingest(try session(seq: seq, end: 20, status: "running")).unread)
        }
        gate.release()
        try await eventually { calls == 2 }
        #expect(!reads.project(next).unread)
        reads.setVisibleSession(nil)
        #expect(reads.ingest(try session(seq: 40, end: 40)).unread)
        await Task.yield()
        #expect(calls == 2)
    }

    @Test func openingBeforeMetadataArrivesStillMarksReadThroughTheRealAPI() async throws {
        let old = try session(), receipt = try session(read: 10)
        let transport = TestHTTPTransport()
        transport.respond = { call in
            #expect(call.method == .post && call.path == "/sessions/read")
            #expect(call.body == .array([.string("session")]))
            return try JSONEncoder().encode(BulkReadFixture(sessions: [receipt]))
        }
        let api = V2SessionAPI(transport: transport)
        let reads = V2SessionReadCoordinator { id in try await api.markRead(sessionIds: [id]).sessions[0] }
        defer { reads.invalidate() }
        reads.setVisibleSession("session")
        #expect(!reads.ingest(old).unread)
        try await eventually { transport.calls.count == 1 }
        reads.setVisibleSession("session")
        await Task.yield()
        #expect(transport.calls.count == 1)
    }

    @Test func transientFailureRetriesWhileVisibleAndRetainsLocalReadProgress() async throws {
        let old = try session(), receipt = try session(read: 10), retryGate = TestGate()
        var calls = 0, pauses: [Duration] = []
        let reads = V2SessionReadCoordinator(send: { _ in
            calls += 1
            if calls == 1 { throw URLError(.notConnectedToInternet) }
            return receipt
        }, sleep: { delay in pauses.append(delay); await retryGate.wait() })
        defer { reads.invalidate(); retryGate.release() }
        _ = reads.ingest(old)
        reads.setVisibleSession(old.id)
        try await eventually { pauses.count == 1 }
        #expect(!reads.project(old).unread && pauses == [.seconds(1)])
        retryGate.release()
        try await eventually { calls == 2 }
        #expect(!reads.ingest(old).unread)
    }

    @Test func retriesStopAfterLeavingAndUnseenTurnsRemainUnread() async throws {
        let old = try session(), retryGate = TestGate()
        var calls = 0, paused = false
        let reads = V2SessionReadCoordinator(send: { _ in
            calls += 1; throw URLError(.timedOut)
        }, sleep: { _ in paused = true; await retryGate.wait() })
        defer { reads.invalidate(); retryGate.release() }
        _ = reads.ingest(old)
        reads.setVisibleSession(old.id)
        try await eventually { paused }
        reads.setVisibleSession(nil)
        #expect(reads.ingest(try session(seq: 20, end: 20)).unread)
        retryGate.release()
        for _ in 0..<10 { await Task.yield() }
        #expect(calls == 1)
    }

    @Test func offlineAndBackgroundReadsResumeOnlyForTheVisibleSession() async throws {
        let old = try session(), receipt = try session(read: 10)
        var calls = 0
        let reads = V2SessionReadCoordinator { _ in calls += 1; return receipt }
        defer { reads.invalidate() }
        reads.updateConnectivity(.init(availability: .offline))
        _ = reads.ingest(old)
        reads.setVisibleSession(old.id)
        #expect(!reads.project(old).unread && calls == 0)
        reads.setActive(false)
        reads.updateConnectivity(.init(availability: .online))
        await Task.yield()
        #expect(calls == 0)
        reads.setActive(true)
        try await eventually { calls == 1 }
        reads.setActive(false)
        #expect(reads.ingest(try session(seq: 20, end: 20)).unread)
        reads.setVisibleSession(nil)
        reads.setActive(true)
        await Task.yield()
        #expect(calls == 1)
    }

    @Test func invalidationRejectsLateResponsesAndClearsAccountScopedWatermarks() async throws {
        let old = try session(), receipt = try session(read: 10), gate = TestGate()
        var calls = 0, changes = 0
        let reads = V2SessionReadCoordinator { _ in calls += 1; await gate.wait(); return receipt }
        reads.onChange = { _ in changes += 1 }
        _ = reads.ingest(old)
        reads.setVisibleSession(old.id)
        try await eventually { calls == 1 }
        reads.invalidate()
        gate.release()
        for _ in 0..<10 { await Task.yield() }
        #expect(changes == 1 && reads.project(old).unread)
        reads.setVisibleSession(old.id)
        #expect(reads.ingest(old).unread && calls == 1)
    }

    @Test func invalidReceiptsDoNotAcknowledgeOtherSessionsOrLoopOnMetadataUpdates() async throws {
        let old = try session(), wrong = try session("other", seq: 30, end: 30, read: 30)
        let correct = try session(seq: 20, end: 20, read: 20)
        var calls = 0
        let reads = V2SessionReadCoordinator { _ in calls += 1; return calls == 1 ? wrong : correct }
        defer { reads.invalidate() }
        _ = reads.ingest(old)
        reads.setVisibleSession(old.id)
        try await eventually { calls == 1 }
        for _ in 0..<5 { _ = reads.ingest(old); await Task.yield() }
        #expect(calls == 1)
        reads.setVisibleSession(nil)
        let next = try session(seq: 20, end: 20)
        #expect(reads.ingest(next).unread)
        reads.setVisibleSession(old.id)
        try await eventually { calls == 2 }
        #expect(!reads.project(next).unread)
    }
}

private struct BulkReadFixture: Encodable {
    let sessions: [V2SessionMeta]
    let notFound: [String] = []
    let serverTime = "now"
}
