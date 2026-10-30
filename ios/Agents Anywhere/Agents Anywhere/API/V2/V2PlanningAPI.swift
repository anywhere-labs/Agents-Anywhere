import Foundation

struct V2PlanningAPI {
    let transport: any HTTPTransport
    func state(sessionId: V2SessionID) async throws -> V2PlanningState {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2PlanningState>(method: .get, path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/planning"))
    }
    func execute(sessionId: V2SessionID, request: V2PlanningRequest) async throws -> V2PlanningResponse {
        try await transport.send(HTTPRequest<V2PlanningRequest, V2PlanningResponse>(method: .post, path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/planning", body: request))
    }
}
