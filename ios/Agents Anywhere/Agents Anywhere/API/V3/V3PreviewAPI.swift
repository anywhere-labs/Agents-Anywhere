import Foundation

/// Port preview resources (preview 1.0). These live under `/api/v3`; the HTTP
/// transport passes versioned paths through instead of adding `/api/v2`.
struct V3PreviewAPI {
    static let path = "/api/v3/previews"
    let transport: any HTTPTransport

    func list() async throws -> V3PreviewListResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V3PreviewListResponse>(method: .get, path: Self.path))
    }

    func create(_ request: V3CreatePreviewRequest) async throws -> V3PreviewView {
        try await transport.send(HTTPRequest<V3CreatePreviewRequest, V3PreviewView>(method: .post, path: Self.path, body: request))
    }

    /// The Server may answer with the closed view or with no body.
    func close(previewId: String) async throws {
        _ = try await transport.send(HTTPRequest<EmptyRequestBody, EmptyResponse>(
            method: .delete, path: "\(Self.path)/\(previewId.v2URLPathComponentEncoded)"))
    }

    /// A one-time ticket URL; request a new one for every open.
    func ticket(previewId: String) async throws -> V3PreviewTicket {
        try await transport.send(HTTPRequest<EmptyRequestBody, V3PreviewTicket>(
            method: .post, path: "\(Self.path)/\(previewId.v2URLPathComponentEncoded)/ticket"))
    }
}
