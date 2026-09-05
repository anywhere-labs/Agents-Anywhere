import Foundation

extension V2ConnectorAPI {
    func downloadWorkspaceFile(connectorId: V2ConnectorID, root: String, path: String) async throws -> WorkspaceDownloadedFile {
        let response = try await transport.send(HTTPRequest<V2WorkspaceFileReadRequest, V2WorkspaceFileReadResponse>(
            method: .post, path: "/connectors/\(connectorId.v2URLPathComponentEncoded)/fs/read",
            queryItems: [URLQueryItem(name: "root", value: root)], body: V2WorkspaceFileReadRequest(path: path)))
        if let error = response.error, !response.ok { throw error }
        guard response.ok, let transfer = response.result, transfer.size >= 0,
              let url = URL(string: transfer.downloadUrl),
              url.path.hasPrefix("/api/v2/connectors/\(connectorId.v2URLPathComponentEncoded)/fs/transfers/") else {
            throw HTTPError.invalidResponse
        }
        let temporary = try await transport.download(url)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        let bytes = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard bytes.map(Int64.init) == transfer.size else {
            throw HTTPError.decoding(message: "文件下载不完整，请重新下载。")
        }
        return try WorkspaceDownloadedFile(moving: temporary, name: transfer.name)
    }
}
