import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct WorkspaceDownloadTests {
    private func sourceFile(_ bytes: Data) throws -> URL {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try bytes.write(to: file)
        return file
    }
    private func transport(size: Int) -> TestHTTPTransport {
        let http = TestHTTPTransport()
        http.respond = { call in
            #expect(call.method == .post && call.path == "/connectors/device/fs/read")
            #expect(call.query.first(where: { $0.name == "root" })?.value == "/work")
            #expect(call.body?["path"] == .string("src/file.bin"))
            return try JSONSerialization.data(withJSONObject: ["ok": true, "result": [
                "name": "../file.bin", "size": size, "downloadUrl": "/api/v2/connectors/device/fs/transfers/transfer?token=transfer-token"
            ]])
        }
        return http
    }

    @Test func explicitDownloadUsesOriginalBytesAndReleasesItsTemporaryExport() async throws {
        let bytes = Data([0, 1, 255, 0, 128])
        let source = try sourceFile(bytes)
        let http = transport(size: bytes.count)
        http.onDownload = { url in
            #expect(url.path == "/api/v2/connectors/device/fs/transfers/transfer")
            #expect(url.query == "token=transfer-token")
            return source
        }
        let service = V2WorkspaceFilesService(connectorAPI: V2ConnectorAPI(transport: http), serverURL: URL(string: "https://example.test")!)
        var file: WorkspaceDownloadedFile? = try await service.download(connectorId: "device", root: "/work",
            entry: V2WorkspaceEntry(name: "file.bin", path: "src/file.bin", type: "file", size: bytes.count, modifiedAt: nil))
        let url = try #require(file?.url)
        #expect(url.lastPathComponent == "file.bin")
        #expect(try Data(contentsOf: url) == bytes)
        #expect(!FileManager.default.fileExists(atPath: source.path))
        #expect(http.calls.count == 1)
        file = nil
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func incompleteDownloadsCannotBeExportedAndTheirBytesAreRemoved() async throws {
        let source = try sourceFile(Data([1, 2]))
        let http = transport(size: 10)
        http.onDownload = { _ in source }
        await #expect(throws: HTTPError.self) {
            _ = try await V2ConnectorAPI(transport: http).downloadWorkspaceFile(connectorId: "device", root: "/work", path: "src/file.bin")
        }
        #expect(!FileManager.default.fileExists(atPath: source.path))
    }

    @Test func cancellationAfterTransferDoesNotLeaveAnExportOrRetryTheRead() async throws {
        let source = try sourceFile(Data([1, 2]))
        let http = transport(size: 2), gate = TestGate()
        var entered = false
        http.onDownload = { _ in entered = true; await gate.wait(); return source }
        let request = Task { try await V2ConnectorAPI(transport: http).downloadWorkspaceFile(connectorId: "device", root: "/work", path: "src/file.bin") }
        try await eventually { entered }
        request.cancel(); gate.release()
        await #expect(throws: CancellationError.self) { _ = try await request.value }
        #expect(!FileManager.default.fileExists(atPath: source.path))
        #expect(http.calls.count == 1)
    }

    @Test func transferCredentialsCannotBeForwardedToAnotherOrigin() async {
        let origin = URL(string: "https://example.test")!
        #expect(URL(string: "https://EXAMPLE.test:443/api/v2/file")!.hasSameOrigin(as: origin))
        for value in ["https://other.test/file", "http://example.test/file", "https://example.test:444/file", "https://user@example.test/file"] {
            #expect(!URL(string: value)!.hasSameOrigin(as: origin))
            let http = URLSessionHTTPTransport(serverURL: origin, tokenProvider: StaticAuthTokenProvider(token: "secret"))
            await #expect(throws: HTTPError.self) { _ = try await http.download(URL(string: value)!) }
        }
    }
}
