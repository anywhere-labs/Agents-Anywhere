import Foundation

struct V2ProjectAPI {
    let transport: any HTTPTransport

    func list() async throws -> V2ProjectListResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2ProjectListResponse>(method: .get, path: "/projects"))
    }
    func create(_ body: V2ProjectCreateRequest) async throws -> V2ProjectResponse {
        try await transport.send(HTTPRequest<V2ProjectCreateRequest, V2ProjectResponse>(method: .post, path: "/projects", body: body))
    }
    func update(_ id: String, _ body: V2ProjectPatchRequest) async throws -> V2ProjectResponse {
        try await transport.send(HTTPRequest<V2ProjectPatchRequest, V2ProjectResponse>(method: .patch, path: path(id), body: body))
    }
    func delete(_ id: String) async throws {
        let _: V2ProjectDeleteResponse = try await transport.send(HTTPRequest<EmptyRequestBody, V2ProjectDeleteResponse>(method: .delete, path: path(id)))
    }
    func sessions(_ id: String, archived: Bool, cursor: String?) async throws -> V2SessionListResponse {
        var query = [URLQueryItem(name: "archived", value: String(archived)), URLQueryItem(name: "limit", value: "100")]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await transport.send(HTTPRequest<EmptyRequestBody, V2SessionListResponse>(method: .get,
            path: path(id) + "/sessions", queryItems: query))
    }
    func archiveSessions(_ id: String, archived: Bool) async throws -> V2ConnectorSessionArchiveResponse {
        try await transport.send(HTTPRequest<V2ConnectorSessionArchiveRequest, V2ConnectorSessionArchiveResponse>(method: .post,
            path: path(id) + "/sessions/archive-all", body: .init(archived: archived, scope: archived ? .active : .archived)))
    }
    private func path(_ id: String) -> String { "/projects/" + id.v2URLPathComponentEncoded }
}
