package com.agentsanywhere.app.feature.realtime

/** E2EE：会话事件流改走设备的安全通道（`subscribe`）。 */
interface SessionStreamRouter {
    /**
     * 返回 null 表示这个会话照常走会话 WebSocket；否则返回关闭订阅的函数。
     * [onMessage] 收到的文本与普通模式的会话 WS 消息是同一个信封；通道关闭时调用 [onClosed]。
     * 需要配对等不能走明文的情况抛 [com.agentsanywhere.app.api.ApiException]。
     */
    suspend fun openSecureStream(
        serverUrl: String,
        token: String?,
        sessionId: String,
        afterCursor: String?,
        onMessage: (String) -> Unit,
        onClosed: () -> Unit,
    ): (() -> Unit)?
}
