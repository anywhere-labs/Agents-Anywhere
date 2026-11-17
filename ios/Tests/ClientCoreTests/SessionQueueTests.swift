import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionQueueTests {
    @Test func queueEventsKeepTheNewestRevisionWithoutMovingTheCursor() throws {
        var projection = V2SessionProjection(snapshot: try snapshot(), maximumItems: 100)
        let cursor = projection.data.cursor
        try projection.apply(event("runtime.queue.updated", seq: 999, id: "queue", payload: ["queue": queueObject(revision: 2, ids: ["a", "b"])]))
        #expect(projection.data.queue?.items.map(\.id) == ["a", "b"])
        // Same event id, older revision: ignored by revision, not by id.
        try projection.apply(event("runtime.queue.updated", seq: 999, id: "queue", payload: ["queue": queueObject(revision: 1, ids: ["old"])]))
        #expect(projection.data.queue?.revision == 2)
        try projection.apply(event("runtime.queue.updated", seq: 999, id: "queue", payload: ["queue": queueObject(revision: 3, ids: [])]))
        #expect(projection.data.queue?.items.isEmpty == true)
        // The envelope borrows the session's sequence; it is no recovery cursor.
        #expect(projection.data.cursor == cursor)
    }

    @Test func snapshotsDecodeTheQueueAndOlderServersOmitIt() throws {
        var object = try fixtureObject("snapshot")
        #expect(try decode(object, as: V2SessionSnapshot.self).queue == nil)
        object["queue"] = queueObject(revision: 4, ids: ["q1"], status: "failed")
        let decoded = try decode(object, as: V2SessionSnapshot.self)
        #expect(decoded.queue?.revision == 4)
        #expect(decoded.queue?.items.first?.error?.message == "boom")
        #expect(V2SessionData(snapshot: decoded).queue == decoded.queue)
    }

    @Test func messagesWaitWhileBusyAndBehindEarlierMessages() throws {
        let empty = try decode(queueObject(revision: 1, ids: []), as: V2SessionQueueState.self)
        let waiting = try decode(queueObject(revision: 1, ids: ["a"]), as: V2SessionQueueState.self)
        let failed = try decode(queueObject(revision: 1, ids: ["a"], status: "failed"), as: V2SessionQueueState.self)
        #expect(V2SessionQueueState.messageMustWait(status: .running, queue: nil))
        #expect(V2SessionQueueState.messageMustWait(status: .waitingApproval, queue: nil))
        #expect(!V2SessionQueueState.messageMustWait(status: .idle, queue: empty))
        #expect(V2SessionQueueState.messageMustWait(status: .idle, queue: waiting))
        #expect(failed.pause(status: .idle) == .failed)
        #expect(waiting.pause(status: .error) == .error)
        #expect(waiting.pause(status: .running) == nil)
        #expect(V2SessionQueueState.merge(waiting, empty) == empty)
    }

    @Test func busySessionHandsTheMessageToTheServerQueue() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            if let response = try runningResponse(call) { return response }
            if call.path.hasSuffix("/runtime/messages") {
                return try JSONSerialization.data(withJSONObject: ["ok": true, "error": NSNull(), "result": [
                    "delivery": "queued", "queuePosition": 1, "queue": queueObject(revision: 5, ids: ["q1"]),
                ]])
            }
            return try http.defaultResponse(call)
        }
        let repo = repository(transport: http)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.queueMode }
        #expect(!model.canSend)
        model.draft = "Later"
        let pending = try #require(await model.sendDraft(delivery: .queue))
        let request = try #require(http.calls.last { $0.path.hasSuffix("/runtime/messages") })
        #expect(request.body?["queue"]?.stringValue == "auto")
        #expect(pending.delivery == .queued)
        #expect(model.pendingMessages.isEmpty)
        #expect(model.draft.isEmpty)
        #expect(model.queue?.items.map(\.id) == ["q1"])
    }

    @Test func idleSendsLeaveTheQueueFieldOut() async throws {
        let http = TestHTTPTransport()
        let repo = repository(transport: http)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.canSend }
        #expect(!model.queueMode)
        model.draft = "Now"
        _ = await model.sendDraft()
        let request = try #require(http.calls.last { $0.path.hasSuffix("/runtime/messages") })
        #expect(request.body?["queue"] == nil)
    }

    @Test func steerUsesTheSteerRoute() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in try runningResponse(call) ?? http.defaultResponse(call) }
        let repo = repository(transport: http)
        defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.canSteer }
        model.draft = "Also check tests"
        _ = await model.sendDraft(delivery: .steer)
        #expect(http.count("/runtime/steer") == 1)
        #expect(http.count("/runtime/messages") == 0)
    }

    @Test func queueActionsUseTheirRoutesAndReplaceTheQueue() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            if call.path.contains("/runtime/queue") { return try JSONSerialization.data(withJSONObject: queueObject(revision: 9, ids: [])) }
            return try http.defaultResponse(call)
        }
        let repo = repository(transport: http)
        defer { repo.reset() }
        _ = try await repo.load(sessionId: "session")
        try await repo.queue(sessionId: "session", action: .sendNow(messageId: "q 1"))
        let call = try #require(http.calls.last)
        #expect(call.method == .post)
        #expect(call.path.hasSuffix("/runtime/queue/q%201/send-now"))
        #expect(repo.cached(sessionId: "session")?.queue?.revision == 9)
        try await repo.queue(sessionId: "session", action: .edit(messageId: "q1", content: "edited"))
        #expect(http.calls.last?.method == .patch)
        #expect(http.calls.last?.body?["content"]?.stringValue == "edited")
        try await repo.queue(sessionId: "session", action: .clear)
        #expect(http.calls.last?.method == .delete)
        #expect(http.calls.last?.path.hasSuffix("/runtime/queue") == true)
    }
}

private func queueObject(revision: Int, ids: [String], status: String = "queued") -> [String: Any] {
    ["sessionId": "session", "revision": revision, "items": ids.enumerated().map { index, id in
        [
            "messageId": id, "sessionId": "session", "clientMessageId": "msg_\(id)", "content": "text \(id)",
            "attachments": [], "status": status, "position": index + 1, "interruptRequested": false,
            "createdBy": "usr", "createdAt": "2026-11-16T00:00:00Z", "updatedAt": "2026-11-16T00:00:00Z",
            "error": status == "failed" ? ["code": "x", "message": "boom"] as Any : NSNull(),
        ] as [String: Any]
    }]
}

private func capability(_ id: String, available: Bool = true) -> [String: Any] {
    ["allowed": true, "available": available, "capabilityId": id, "parameters": [:], "runtime": "claude",
     "runtimeId": "rti_work", "scope": "runtime", "sessionId": NSNull(), "supported": true,
     "unavailableReason": available ? NSNull() : "session_running", "version": "1"]
}

/// A running session whose runtime can queue and steer but not start a turn.
private func runningResponse(_ call: TestHTTPTransport.Call) throws -> Data? {
    let capabilities: [String: Any] = ["revision": 11, "capabilities": [
        capability("session.send_message", available: false), capability("session.queue"),
        capability("session.steer"), capability("session.interrupt"),
    ]]
    func running(_ object: [String: Any]) -> [String: Any] {
        var state = object; state["status"] = "running"; return state
    }
    if call.path.hasSuffix("/snapshot") {
        var object = try fixtureObject("snapshot")
        object["state"] = running(object["state"] as! [String: Any])
        object["effectiveCapabilities"] = capabilities
        return try JSONSerialization.data(withJSONObject: object)
    }
    if call.path.hasSuffix("/runtime/state") {
        var object = try fixtureObject("state")
        object["state"] = running(object["state"] as! [String: Any])
        return try JSONSerialization.data(withJSONObject: object)
    }
    if call.path.hasSuffix("/runtime/capabilities") {
        var object = try fixtureObject("capabilities")
        object["capabilitySet"] = capabilities
        return try JSONSerialization.data(withJSONObject: object)
    }
    return nil
}
