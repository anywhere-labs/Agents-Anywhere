import Foundation
import Testing
@testable import ClientCore

nonisolated private final class CloseState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isClosed: Bool { lock.withLock { value } }
    func close() { lock.withLock { value = true } }
}

@MainActor private final class TestSocketConnection: WebSocketConnection, @unchecked Sendable {
    private let stream: AsyncThrowingStream<Data, Error>
    let continuation: AsyncThrowingStream<Data, Error>.Continuation
    nonisolated private let closed = CloseState()
    var isClosed: Bool { closed.isClosed }
    init() { (stream, continuation) = AsyncThrowingStream.makeStream() }
    func messages() -> AsyncThrowingStream<Data, Error> { stream }
    nonisolated func close() { closed.close(); continuation.finish() }
}

@MainActor private final class TestSocketTransport: WebSocketTransport {
    let connection = TestSocketConnection()
    var url: URL?
    func connect(url: URL) -> any WebSocketConnection { self.url = url; return connection }
}

@Suite @MainActor struct RealtimeTests {
    @Test func ticketURLKeepaliveAndCancellation() async throws {
        let socket = TestSocketTransport()
        let api = V2RealtimeAPI(serverURL: URL(string: "https://example.test/api/v2?old=yes")!, transport: TestHTTPTransport(), webSocketTransport: socket)
        let stream = try api.sessionEvents(sessionId: "session", ticket: "ticket + &?")
        #expect(socket.url?.scheme == "wss")
        #expect(socket.url?.path == "/api/v2/sessions/session/ws")
        #expect(URLComponents(url: socket.url!, resolvingAgainstBaseURL: false)?.queryItems == [URLQueryItem(name: "ticket", value: "ticket + &?")])
        var received = 0
        let consume = Task { for try await _ in stream { received += 1 } }
        socket.connection.continuation.yield(Data(#"{"type":"keepalive"}"#.utf8))
        socket.connection.continuation.yield(try fixtureData("event"))
        try await eventually { received == 1 }
        consume.cancel(); _ = await consume.result
        try await eventually { socket.connection.isClosed }
    }

    @Test func silentConnectionTimesOutEvenWhenPathIsOnline() async throws {
        let socket = TestSocketTransport()
        let api = V2RealtimeAPI(serverURL: URL(string: "https://example.test")!, transport: TestHTTPTransport(), webSocketTransport: socket,
                                heartbeatTimeout: .milliseconds(20), heartbeatCheckInterval: .milliseconds(5))
        let stream = try api.dashboardSnapshots(ticket: "ticket")
        do { for try await _ in stream {}; Issue.record("Expected silent socket timeout") }
        catch { #expect((error as? URLError)?.code == .timedOut) }
        #expect(socket.connection.isClosed)
    }

    @Test func overflowForcesRecoveryInsteadOfSilentlyDroppingEvents() async throws {
        let socket = TestSocketTransport()
        let api = V2RealtimeAPI(serverURL: URL(string: "https://example.test")!, transport: TestHTTPTransport(), webSocketTransport: socket)
        let stream = try api.sessionEvents(sessionId: "session", ticket: "ticket")
        let data = try fixtureData("event")
        for _ in 0..<2050 { socket.connection.continuation.yield(data) }
        try await eventually { socket.connection.isClosed }
        var received = 0
        do { for try await _ in stream { received += 1 }; Issue.record("Expected stream overflow") }
        catch { #expect(error is HTTPError) }
        #expect(received == 2048)
    }
}
