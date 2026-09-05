import Foundation
import Testing
@testable import ClientCore

func fixtureObject(_ name: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: fixtureData(name)) as! [String: Any]
}

func decode<Value: Decodable>(_ object: [String: Any], as: Value.Type = Value.self) throws -> Value {
    try JSONDecoder().decode(Value.self, from: JSONSerialization.data(withJSONObject: object))
}

func snapshot(id: String = "session", items: [[String: Any]]? = nil, hasMore: Bool = false) throws -> V2SessionSnapshot {
    var object = try fixtureObject("snapshot")
    var meta = object["session"] as! [String: Any]; meta["id"] = id; object["session"] = meta
    var state = object["state"] as! [String: Any]; state["sessionId"] = id; object["state"] = state
    var timeline = object["timeline"] as! [String: Any]
    timeline["items"] = try items ?? [itemObject(sessionID: id)]
    timeline["hasMore"] = hasMore; object["timeline"] = timeline
    return try decode(object)
}

func itemObject(id: String = "item", sessionID: String = "session", order: Int = 1, revision: Int = 1, seq: Int = 10, text: String = "Hello", clientID: String? = nil) throws -> [String: Any] {
    var item = (try fixtureObject("timeline")["items"] as! [[String: Any]])[0]
    item["id"] = id; item["sessionId"] = sessionID; item["orderSeq"] = order
    item["revision"] = revision; item["updatedSeq"] = seq; item["content"] = ["text": text]
    if let clientID { item["role"] = "user"; item["source"] = ["clientMessageId": clientID] }
    return item
}

func event(_ type: String, seq: Int = 10, id: String? = nil, sessionID: String = "session", payload: [String: Any] = [:]) throws -> V2SessionEvent {
    var object = try fixtureObject("event")
    object["type"] = type; object["sequence"] = seq; object["cursor"] = "seq:\(seq)"
    object["eventId"] = id ?? UUID().uuidString; object["sessionId"] = sessionID; object["payload"] = payload
    return try decode(object)
}

@MainActor func eventually(_ predicate: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    for _ in 0..<1000 {
        if predicate() { return }
        try await Task.sleep(for: .milliseconds(1))
    }
    #expect(predicate(), "Condition did not become true", sourceLocation: sourceLocation)
    throw URLError(.timedOut)
}

@MainActor final class TestGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    var released = false
    func wait() async { if !released { await withCheckedContinuation { waiters.append($0) } } }
    func release() { released = true; let old = waiters; waiters = []; old.forEach { $0.resume() } }
}

@MainActor final class TestHTTPTransport: HTTPTransport {
    struct Call {
        let method: HTTPMethod
        let path: String
        let query: [URLQueryItem]
        let body: JSONValue?
    }
    var calls: [Call] = []
    var respond: ((Call) async throws -> Data)?

    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response {
        let call = Call(method: request.method, path: request.path, query: request.queryItems,
                        body: try request.body.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) })
        calls.append(call)
        let data = try await respond?(call) ?? defaultResponse(call)
        return try JSONDecoder().decode(Response.self, from: data)
    }

    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response {
        try JSONDecoder().decode(Response.self, from: fixtureData("upload"))
    }

    func count(_ suffix: String) -> Int { calls.filter { $0.path.hasSuffix(suffix) }.count }

    func defaultResponse(_ call: Call) throws -> Data {
        let fixtures = ["snapshot": "snapshot", "timeline": "timeline", "state": "state",
                        "capabilities": "capabilities", "notices": "notices", "catalogs/model": "modelCatalog",
                        "catalogs/permission": "permissionCatalog", "selections": "state", "takeover": "takeover",
                        "runtime-types": "runtimeTypes", "runtimes": "runtimes", "preferences": "preferences",
                        "commands": "commands", "readText": "text", "ws-ticket": "ticket", "events": "recovery"]
        if let pair = fixtures.first(where: { call.path.hasSuffix("/" + $0.key) }) { return try fixtureData(pair.value) }
        return try fixtureData("rpc")
    }
}

@MainActor final class TestRealtimeAPI: V2RealtimeAPIProtocol {
    var tickets = 0
    var recoveries: [String] = []
    var streams: [AsyncThrowingStream<V2SessionEvent, Error>.Continuation] = []
    var onRecover: (() async throws -> V2EventRecoveryResponse)?

    func ticket(clientId: String, scope: V2RealtimeScope) async throws -> V2WebSocketTicket {
        tickets += 1; return try fixture("ticket")
    }
    func recover(sessionId: V2SessionID, after cursor: String) async throws -> V2EventRecoveryResponse {
        recoveries.append(cursor)
        if let onRecover { return try await onRecover() }
        return V2EventRecoveryResponse(events: [], nextCursor: cursor, snapshotRequired: false, serverTime: "")
    }
    func sessionEvents(sessionId: V2SessionID, ticket: String) throws -> AsyncThrowingStream<V2SessionEvent, Error> {
        AsyncThrowingStream { continuation in
            streams.append(continuation)
            continuation.yield(try! event("session.subscribed", seq: 10, sessionID: sessionId))
        }
    }
    func dashboardSnapshots(ticket: String) throws -> AsyncThrowingStream<V2DashboardSnapshot, Error> { AsyncThrowingStream { $0.finish() } }
    func yield(_ event: V2SessionEvent) { streams.last?.yield(event) }
}

@MainActor func repository(transport: TestHTTPTransport, realtime: TestRealtimeAPI? = nil, policy: V2SessionCachePolicy = V2SessionCachePolicy(), now: @escaping () -> Date = Date.init) -> V2SessionRepository {
    let runtime = V2RuntimeAPI(transport: transport)
    return V2SessionRepository(
        scope: V2ClientScope(serverURL: URL(string: "https://example.test/api/v2")!, accountID: "account"),
        detail: V2SessionDetailService(sessionAPI: V2SessionAPI(transport: transport), runtimeAPI: runtime, realtimeAPI: realtime ?? TestRealtimeAPI()),
        interactions: V2RuntimeInteractionService(runtimeAPI: runtime), policy: policy, now: now,
        sleep: { _ in try await Task.sleep(for: .milliseconds(1)) }
    )
}
