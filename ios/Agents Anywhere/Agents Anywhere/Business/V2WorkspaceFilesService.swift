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
        guard response.ok else {
            throw V2BusinessError.workspaceFilesUnavailable(
                message: response.error ?? String(localized: "The workspace directory is unavailable.")
            )
        }
        return response.result
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
