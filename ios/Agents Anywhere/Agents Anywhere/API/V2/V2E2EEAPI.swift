import Foundation

nonisolated protocol V2E2EEAPIProtocol {
    /// `POST /api/v2/ws-ticket {clientId, scope: {dashboard: true}}`：隧道 WS 的一次性票据。
    func tunnelTicket(clientId: String) async throws -> V2WebSocketTicket
    /// `POST /api/v3/e2ee/commands`：加密命令在经通道发出前登记，Server 据此去重。
    func registerCommand(_ registration: E2EECommandRegistration) async throws -> E2EECommandRegistrationResponse
}

nonisolated struct V2E2EEAPI: V2E2EEAPIProtocol {
    let transport: any HTTPTransport

    func tunnelTicket(clientId: String) async throws -> V2WebSocketTicket {
        try await transport.send(HTTPRequest<V2WebSocketTicketRequest, V2WebSocketTicket>(
            method: .post,
            path: "/ws-ticket",
            body: V2WebSocketTicketRequest(clientId: clientId, scope: V2WebSocketTicketScope(scope: .dashboard))
        ))
    }

    func registerCommand(_ registration: E2EECommandRegistration) async throws -> E2EECommandRegistrationResponse {
        try await transport.send(HTTPRequest<E2EECommandRegistration, E2EECommandRegistrationResponse>(
            method: .post,
            path: "/api/v3/e2ee/commands",
            body: registration
        ))
    }
}
