@testable import ClientCore
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

/// 供进程内协议测试使用的通道对端。
nonisolated protocol E2EETunnel: Sendable {
    func open(_ route: E2EETunnelRoute) async throws -> any E2EETunnelLink
    /// 关掉底层连接，结束所有路由。
    func shutdown() async
}
