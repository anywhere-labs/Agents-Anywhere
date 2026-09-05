import Foundation

struct V2WorkspaceFilesService {
    let connectorAPI: any V2ConnectorAPIProtocol
    let serverURL: URL

    /// Reads one directory from the connector through the server RPC boundary.
    func directory(
        connectorId: V2ConnectorID,
        root: String,
        path: String
    ) async throws -> V2WorkspaceDirectory {
        let response = try await connectorAPI.listWorkspaceFiles(
            connectorId: connectorId,
            request: V2WorkspaceFilesListRequest(root: root, path: path)
        )
        if let error = response.error, !response.ok { throw error }
        guard response.ok, let directory = response.result else {
            throw V2BusinessError.workspaceFilesUnavailable(
                message: String(localized: "The workspace directory is unavailable.")
            )
        }
        return directory
    }

    func readText(connectorId: V2ConnectorID, root: String, path: String, maxBytes: Int = 1_048_576) async throws -> V2WorkspaceTextResponse {
        guard (1...4_194_304).contains(maxBytes) else { throw V2BusinessError.invalidPageSize }
        return try await connectorAPI.readWorkspaceText(
            connectorId: connectorId, root: root,
            request: V2WorkspaceTextRequest(path: path, maxBytes: maxBytes)
        )
    }

    /// Creates a one-use scoped token and returns the existing Web file-preview route.
    func previewURL(
        connectorId: V2ConnectorID,
        root: String,
        entry: V2WorkspaceEntry
    ) async throws -> URL {
        guard entry.isFile else { throw V2BusinessError.workspaceEntryNotPreviewable }
        let token = try await connectorAPI.createWorkspaceFilePreviewToken(
            connectorId: connectorId,
            root: root,
            request: V2WorkspaceFileReadRequest(path: entry.path)
        )
        return try makePreviewURL(previewToken: token.previewToken, name: entry.name)
    }

    private func makePreviewURL(previewToken: String, name: String) throws -> URL {
        let rootURL = URL(string: "/", relativeTo: serverURL)?.absoluteURL ?? serverURL
        guard var components = URLComponents(url: rootURL, resolvingAgainstBaseURL: false) else {
            throw V2BusinessError.invalidWorkspacePreviewURL
        }
        var fragmentComponents = URLComponents()
        fragmentComponents.queryItems = [
            URLQueryItem(name: "previewToken", value: previewToken),
            URLQueryItem(name: "name", value: name),
        ]
        guard let query = fragmentComponents.percentEncodedQuery else {
            throw V2BusinessError.invalidWorkspacePreviewURL
        }
        components.query = nil
        components.percentEncodedFragment = "/preview?\(query)"
        guard let url = components.url else {
            throw V2BusinessError.invalidWorkspacePreviewURL
        }
        return url
    }
}
