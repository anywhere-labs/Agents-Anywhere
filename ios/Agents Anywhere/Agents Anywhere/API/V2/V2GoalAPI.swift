import Foundation

struct V2GoalAPI {
  let transport: any HTTPTransport
  func state(sessionId: V2SessionID) async throws -> V2GoalState {
    try await transport.send(
      HTTPRequest<EmptyRequestBody, V2GoalState>(
        method: .get, path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/goal"))
  }
  func execute(sessionId: V2SessionID, request: V2GoalRequest) async throws -> V2GoalResponse {
    try await transport.send(
      HTTPRequest<V2GoalRequest, V2GoalResponse>(
        method: .post, path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/goal", body: request)
    )
  }
  func operation(sessionId: V2SessionID, id: String) async throws -> V2GoalResponse {
    try await transport.send(
      HTTPRequest<EmptyRequestBody, V2GoalResponse>(
        method: .get, path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/goal/operations/\(id)"
      ))
  }
}
