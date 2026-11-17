import Foundation
import Synchronization

/// 隧道上从 Server 收到的、属于某条路由的东西。
nonisolated enum E2EETunnelInbound: Hashable, Sendable {
    case frame(E2EEChannelItem)
    /// `ClientTunnelEnd`：设备结束了调用、设备离线，或者隧道本身断了（`closed`）。
    case end(code: String)
}

/// 一条路由 `(deviceId, clientId, ch)` 的收发端。
nonisolated protocol E2EETunnelLink: AnyObject, Sendable {
    var route: E2EETunnelRoute { get }
    /// 按到达顺序给出该路由的帧与结束码；只能有一个消费者。结束后流也结束。
    var inbound: AsyncStream<E2EETunnelInbound> { get }
    /// 排队发出一帧；帧按调用顺序离开。
    func send(_ item: E2EEChannelItem)
    /// 客户端取消这次调用（发 `ClientTunnelEnd`）。可以重复调用。
    func end(code: String)
}

/// 打开路由的入口。默认实现是 `URLSessionE2EETunnel`（`WS /api/v3/tunnel`）。
nonisolated protocol E2EETunnel: Sendable {
    func open(_ route: E2EETunnelRoute) async throws -> any E2EETunnelLink
    /// 关掉底层连接，结束所有路由。
    func shutdown() async
}

/// 隧道底层的一条文本 WebSocket；测试里换成内存实现。
nonisolated protocol E2EETunnelSocket: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

nonisolated final class URLSessionE2EETunnelSocket: E2EETunnelSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
        task.resume()
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        while true {
            switch try await task.receive() {
            case let .string(text): return text
            case let .data(data): return String(decoding: data, as: UTF8.self)
            @unknown default: continue
            }
        }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

// MARK: - 线上的 JSON

/// `ClientTunnelFrame {t: "tun", route, n, ct}` 与 `ClientTunnelEnd {t: "end", route, code}`。
nonisolated enum E2EETunnelWire {
    private struct Frame: Codable {
        let t: String
        let route: E2EETunnelRoute
        let n: UInt64?
        let ct: String?
        let code: String?
    }

    static func encodeFrame(_ route: E2EETunnelRoute, _ item: E2EEChannelItem) -> String {
        encode(Frame(t: "tun", route: route, n: item.n, ct: item.ct, code: nil))
    }

    static func encodeEnd(_ route: E2EETunnelRoute, code: String) -> String {
        encode(Frame(t: "end", route: route, n: nil, ct: nil, code: code))
    }

    /// 解析 Server 发来的一条消息；不认识的类型（比如 keepalive）返回 nil。
    static func decode(_ text: String) -> (E2EETunnelRoute, E2EETunnelInbound)? {
        guard let frame = try? JSONDecoder().decode(Frame.self, from: Data(text.utf8)) else { return nil }
        switch frame.t {
        case "tun":
            guard let n = frame.n, let ct = frame.ct else { return nil }
            return (frame.route, .frame(E2EEChannelItem(n: n, ct: ct)))
        case "end":
            return (frame.route, .end(code: frame.code ?? E2EEError.closed))
        default:
            return nil
        }
    }

    private static func encode(_ frame: Frame) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Encoding plain strings and integers cannot fail.
        return String(decoding: (try? encoder.encode(frame)) ?? Data(), as: UTF8.self)
    }
}

// MARK: - 默认实现

/// 一条 WebSocket 上复用多条路由：`POST /api/v2/ws-ticket {clientId, scope: {tunnel: true}}` 拿票，
/// 再连 `WS /api/v3/tunnel?ticket=…`。连接断开时所有路由收到 `end(closed)`，下次打开时重新连接。
///
/// Server 侧的隧道 WS 与这个票据 scope 由另一项工作实现，这里还没有和真实 Server 联调。
nonisolated final class URLSessionE2EETunnel: E2EETunnel {
    typealias TicketProvider = @Sendable () async throws -> String
    typealias SocketFactory = @Sendable (URL) -> any E2EETunnelSocket

    private let serverURL: URL
    private let ticket: TicketProvider
    private let makeSocket: SocketFactory
    private let connector = Connector()

    init(serverURL: URL, ticket: @escaping TicketProvider, makeSocket: @escaping SocketFactory) {
        self.serverURL = serverURL.normalizedV2ServerURL()
        self.ticket = ticket
        self.makeSocket = makeSocket
    }

    convenience init(serverURL: URL, urlSession: URLSession, ticket: @escaping TicketProvider) {
        self.init(serverURL: serverURL, ticket: ticket) { url in
            URLSessionE2EETunnelSocket(task: urlSession.webSocketTask(with: url))
        }
    }

    func open(_ route: E2EETunnelRoute) async throws -> any E2EETunnelLink {
        let connection = try await connector.connection { [serverURL, ticket, makeSocket] in
            let url = try Self.tunnelURL(serverURL: serverURL, ticket: try await ticket())
            return TunnelConnection(socket: makeSocket(url))
        }
        return try connection.open(route)
    }

    func shutdown() async {
        await connector.shutdown()
    }

    static func tunnelURL(serverURL: URL, ticket: String) throws -> URL {
        guard var components = URLComponents(url: serverURL.normalizedV2ServerURL().appendingPathComponent("api/v3/tunnel"), resolvingAgainstBaseURL: false) else {
            throw HTTPError.invalidRequestURL(path: "/api/v3/tunnel")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        guard let url = components.url else { throw HTTPError.invalidRequestURL(path: "/api/v3/tunnel") }
        return url
    }

    /// 同一时刻只建一条连接；连接结束后下一次打开重新建。
    private actor Connector {
        private var current: TunnelConnection?
        private var pending: Task<TunnelConnection, Error>?

        func connection(_ make: @escaping @Sendable () async throws -> TunnelConnection) async throws -> TunnelConnection {
            if let current, !current.isClosed { return current }
            if let pending { return try await pending.value }
            let task = Task { try await make() }
            pending = task
            defer { pending = nil }
            let connection = try await task.value
            current = connection
            return connection
        }

        func shutdown() {
            pending?.cancel()
            current?.close(code: E2EEError.closed)
            current = nil
        }
    }
}

/// 一条隧道 WebSocket：一个写任务保证帧的顺序，一个读任务按路由分发。
nonisolated private final class TunnelConnection: Sendable {
    private let socket: any E2EETunnelSocket
    private let outgoing: AsyncStream<String>.Continuation
    private let links = Mutex<[E2EETunnelRoute: TunnelLink]?>([:])
    private let tasks = Mutex<[Task<Void, Never>]>([])

    init(socket: any E2EETunnelSocket) {
        self.socket = socket
        let (stream, continuation) = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        outgoing = continuation
        let writer = Task { [weak self, socket] in
            for await text in stream {
                do { try await socket.send(text) } catch { self?.close(code: E2EEError.closed); return }
            }
        }
        let reader = Task { [weak self, socket] in
            while !Task.isCancelled {
                do {
                    let text = try await socket.receive()
                    if let (route, inbound) = E2EETunnelWire.decode(text) { self?.dispatch(route, inbound) }
                } catch {
                    self?.close(code: E2EEError.closed)
                    return
                }
            }
        }
        tasks.withLock { $0 = [writer, reader] }
    }

    var isClosed: Bool { links.withLock { $0 == nil } }

    func open(_ route: E2EETunnelRoute) throws -> TunnelLink {
        let link = TunnelLink(route: route, outgoing: outgoing) { [weak self] route in
            self?.links.withLock { _ = $0?.removeValue(forKey: route) }
        }
        let opened = links.withLock { links -> Bool in
            guard links != nil, links?[route] == nil else { return false }
            links?[route] = link
            return true
        }
        guard opened else { throw E2EEError(code: E2EEError.closed, message: "tunnel closed or route in use") }
        return link
    }

    func close(code: String) {
        guard let open = links.withLock({ links -> [TunnelLink]? in
            defer { links = nil }
            return links.map { Array($0.values) }
        }) else { return }
        for link in open { link.remoteEnded(code: code) }
        outgoing.finish()
        tasks.withLock { $0.forEach { $0.cancel() } }
        socket.close()
    }

    private func dispatch(_ route: E2EETunnelRoute, _ inbound: E2EETunnelInbound) {
        guard let link = links.withLock({ $0?[route] }) else { return }
        switch inbound {
        case .frame: link.deliver(inbound)
        case let .end(code):
            links.withLock { _ = $0?.removeValue(forKey: route) }
            link.remoteEnded(code: code)
        }
    }
}

nonisolated private final class TunnelLink: E2EETunnelLink {
    let route: E2EETunnelRoute
    let inbound: AsyncStream<E2EETunnelInbound>
    private let continuation: AsyncStream<E2EETunnelInbound>.Continuation
    private let outgoing: AsyncStream<String>.Continuation
    private let onEnd: @Sendable (E2EETunnelRoute) -> Void
    private let ended = Mutex(false)

    init(route: E2EETunnelRoute, outgoing: AsyncStream<String>.Continuation, onEnd: @escaping @Sendable (E2EETunnelRoute) -> Void) {
        self.route = route
        self.outgoing = outgoing
        self.onEnd = onEnd
        (inbound, continuation) = AsyncStream<E2EETunnelInbound>.makeStream(bufferingPolicy: .unbounded)
    }

    func send(_ item: E2EEChannelItem) {
        guard !ended.withLock({ $0 }) else { return }
        outgoing.yield(E2EETunnelWire.encodeFrame(route, item))
    }

    func end(code: String) {
        guard !ended.withLock({ value in defer { value = true }; return value }) else { return }
        outgoing.yield(E2EETunnelWire.encodeEnd(route, code: code))
        continuation.finish()
        onEnd(route)
    }

    func deliver(_ inbound: E2EETunnelInbound) {
        continuation.yield(inbound)
    }

    func remoteEnded(code: String) {
        guard !ended.withLock({ value in defer { value = true }; return value }) else { return }
        continuation.yield(.end(code: code))
        continuation.finish()
    }
}
