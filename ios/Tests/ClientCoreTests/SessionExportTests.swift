import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionExportTests {
    private func service(_ http: TestHTTPTransport) -> V2SessionDetailService {
        V2SessionDetailService(sessionAPI: V2SessionAPI(transport: http), runtimeAPI: V2RuntimeAPI(transport: http), realtimeAPI: TestRealtimeAPI())
    }

    @Test func exportPagesIndependentlyAndPreservesTheNewestRawItems() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            guard call.path.hasSuffix("timeline") else { return try http.defaultResponse(call) }
            #expect(call.query.contains(URLQueryItem(name: "mode", value: "changes")))
            #expect(call.query.contains(URLQueryItem(name: "limit", value: "500")))
            let after = call.query.first { $0.name == "afterSeq" }?.value
            var page = try fixtureObject("timeline")
            if after == "0" {
                page["items"] = try [itemObject(id: "a", order: 1, seq: 10), itemObject(id: "b", order: 2, seq: 11)]
                page["hasMore"] = true; page["nextSeq"] = 30
            } else {
                #expect(after == "11")
                page["items"] = try [itemObject(id: "a", order: 1, revision: 2, seq: 20, text: "Final")]
                page["hasMore"] = false; page["nextSeq"] = 30
            }
            return try JSONSerialization.data(withJSONObject: page)
        }
        let repo = repository(transport: http)
        defer { repo.reset() }
        let cached = try await repo.load(sessionId: "session")
        let result = try await service(http).exportTimeline(sessionId: "session")
        #expect(result.items.map { $0["id"]?.stringValue } == ["a", "b"])
        #expect(result.items[0]["content"]?["text"] == .string("Final"))
        #expect(result.source == "remote" && result.nextSeq == 30 && !result.hasMore)
        #expect(repo.cached(sessionId: "session")?.items.map(\.id) == cached.items.map(\.id))
        #expect(http.count("timeline") == 2)
        let json = try JSONDecoder().decode(JSONValue.self, from: result.encoded())
        #expect(json["items"]?.arrayValue?.count == 2)
    }

    @Test func aStalledCursorCannotProduceAnApparentlyCompleteExport() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            guard call.path.hasSuffix("timeline") else { return try http.defaultResponse(call) }
            var page = try fixtureObject("timeline")
            page["items"] = []; page["hasMore"] = true; page["nextSeq"] = 500
            return try JSONSerialization.data(withJSONObject: page)
        }
        do { _ = try await service(http).exportTimeline(sessionId: "session"); Issue.record("Stalled export succeeded") }
        catch { #expect((error as? V2ClientFailure)?.kind == .unavailable) }
        #expect(http.count("timeline") == 1)
    }

    @Test func exportRejectsAnotherSessionsPage() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            guard call.path.hasSuffix("timeline") else { return try http.defaultResponse(call) }
            var page = try fixtureObject("timeline"); page["sessionId"] = "other"
            return try JSONSerialization.data(withJSONObject: page)
        }
        do { _ = try await service(http).exportTimeline(sessionId: "session"); Issue.record("Mismatched export succeeded") }
        catch { #expect((error as? V2ClientFailure)?.kind == .unavailable) }
    }

    @Test func cancellationDiscardsAnAlreadyInFlightFinalPage() async throws {
        let http = TestHTTPTransport(); let gate = TestGate()
        http.respond = { call in
            if call.path.hasSuffix("timeline") { await gate.wait() }
            return try http.defaultResponse(call)
        }
        let task = Task { try await service(http).exportTimeline(sessionId: "session") }
        try await eventually { http.count("timeline") == 1 }
        task.cancel(); gate.release()
        do { _ = try await task.value; Issue.record("Cancelled export succeeded") }
        catch { #expect(error is CancellationError) }
    }
}
