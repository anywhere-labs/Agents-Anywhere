import Foundation
import CoreGraphics
import ImageIO
import Testing
@testable import ClientCore

@Suite @MainActor struct ChatSessionPolishTests {
    private func chat(_ http: TestHTTPTransport) -> SessionChatModel {
        let repo = repository(transport: http)
        return SessionChatModel(session: repo.session(id: "session"), repository: repo,
            attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)))
    }

    @Test func openingLoadsBackToTheLatestUserInsteadOfChoosingTheLastTool() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            if call.path.hasSuffix("snapshot") {
                var snapshot = try fixtureObject("snapshot")
                var timeline = snapshot["timeline"] as! [String: Any]
                var tool = try itemObject(id: "tool", order: 100)
                tool["type"] = "tool"; tool["content"] = ["kind": "command", "command": "pwd"]
                timeline["items"] = [tool]; timeline["hasMore"] = true; snapshot["timeline"] = timeline
                return try JSONSerialization.data(withJSONObject: snapshot)
            }
            if call.path.hasSuffix("timeline") {
                #expect(call.query.contains { $0.name == "beforeOrderSeq" && $0.value == "100" })
                var page = try fixtureObject("timeline")
                var user = try itemObject(id: "user", order: 90); user["role"] = "user"
                page["items"] = [user]; page["hasMore"] = false
                return try JSONSerialization.data(withJSONObject: page)
            }
            return try http.defaultResponse(call)
        }
        let model = chat(http)
        defer { model.repository.reset() }
        await model.prepareOpening()
        #expect(model.isOpeningPrepared && model.openingTargetID == "user" && model.openingError == nil)
        #expect(http.count("snapshot") == 1 && http.count("timeline") == 1)
    }

    @Test func openingNetworkFailureIsActionableWithoutAnEndlessLoadingPhase() async {
        let http = TestHTTPTransport()
        http.respond = { _ in throw URLError(.notConnectedToInternet) }
        let model = chat(http)
        defer { model.repository.reset() }
        await model.prepareOpening()
        #expect(model.isOpeningPrepared && model.openingError != nil && model.openingTargetID == nil)
    }

    @Test func optimisticAttachmentMetadataAndPreviewsSurviveReorderedOrSparseEchoes() throws {
        let store = ChatAttachmentStore()
        let first = ChatAttachment(id: "a", name: "first.png", data: Data([1]), mediaType: "image/png", previewData: Data([11]))
        let second = ChatAttachment(id: "b", name: "second.pdf", data: Data([2, 3]), mediaType: "application/pdf")
        store.remember([first, second], clientID: "message")
        let sparse = V2AttachmentContent(rawContent: .object(["fileId": .string("local:a"), "name": .null]))
        let files = store.resolve([second.content, sparse], clientID: "message")
        #expect(files[0].content.name == "second.pdf" && files[0].previewData == nil)
        #expect(files[1].content.name == "first.png" && files[1].previewData == Data([11]))
        #expect(store.resolve([], clientID: "message").count == 2)
        let unknown = V2AttachmentContent(rawContent: .object(["fileId": .string("another-file")]))
        #expect(store.resolve([unknown], clientID: "message")[0].previewData == nil)
    }

    @Test func previewCacheIsBoundedAndClearedWithTheSession() {
        let store = ChatAttachmentStore(byteLimit: 4)
        let first = V2AttachmentContent(rawContent: .object(["fileId": .string("first")]))
        let second = V2AttachmentContent(rawContent: .object(["fileId": .string("second")]))
        store.cache(Data([1, 2, 3]), for: first)
        store.cache(Data([4, 5, 6]), for: second)
        #expect(store.preview(for: first) == nil && store.preview(for: second) == Data([4, 5, 6]))
        store.clear()
        #expect(store.preview(for: second) == nil)
    }

    @Test func deviceImagesAndUploadedAttachmentsChooseDifferentReadRoutes() {
        let device = V2AttachmentContent(rawContent: .object(["fileId": .string("artifact"), "path": .string("out/chart.png"), "root": .string("/repo")]))
        let uploaded = V2AttachmentContent(rawContent: .object(["fileId": .string("file_upload"), "path": .string("out/chart.png"),
            "openUrl": .string("/api/v2/sessions/session/attachments/file_upload/open"), "mediaType": .string("image/png")]))
        #expect(device.isImage && device.readsFromDevice && device.root == "/repo")
        #expect(uploaded.isImage && !uploaded.readsFromDevice)
        #expect(ChatImageThumbnail.make(data: Data("not an image".utf8)) == nil)
    }

    @Test func deviceThumbnailUsesFSReadAndItsCachedPreviewWorksOffline() async throws {
        let context = try #require(CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.7, blue: 0.3, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        let bytes = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
        #expect(CGImageDestinationFinalize(destination))
        let http = TestHTTPTransport()
        let repo = repository(transport: http)
        defer { repo.reset() }
        _ = try await repo.load(sessionId: "session")
        let session = repo.session(id: "session")
        let connector = try #require(session.metadata?.connectorId)
        let model = SessionChatModel(session: session, repository: repo,
            attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)),
            files: .init(connectorAPI: V2ConnectorAPI(transport: http), serverURL: URL(string: "https://example.test")!))
        http.respond = { call in
            #expect(call.path == "/connectors/\(connector)/fs/read" && call.method == .post)
            #expect(call.query.contains { $0.name == "root" && $0.value == "/custom-root" })
            #expect(call.body?["path"] == .string("chart.png"))
            return try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["name": "chart.png", "size": bytes.length,
                "downloadUrl": "/api/v2/connectors/\(connector)/fs/transfers/image"]])
        }
        http.onDownload = { _ in
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try (bytes as Data).write(to: url)
            return url
        }
        let file = V2AttachmentContent(rawContent: .object(["fileId": .string("device-image"),
            "path": .string("chart.png"), "root": .string("/custom-root")]))
        let preview = try #require(await model.thumbnail(for: file))
        #expect(!preview.isEmpty && http.count("fs/read") == 1)
        repo.updateConnectivity(.init(availability: .offline))
        #expect(try await model.thumbnail(for: file) == preview)
        #expect(http.count("fs/read") == 1)
    }

    @Test func sendingClearsImmediatelyAndAFailedWriteRestoresTheAttachmentDraft() async throws {
        let http = TestHTTPTransport(), realtime = TestRealtimeAPI(), gate = TestGate()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let session = repo.session(id: "session"), connection = Task { await repo.session(id: "session").connect() }
        defer { connection.cancel() }
        try await eventually { session.canSend }
        http.respond = { call in
            if call.path.hasSuffix("messages") { await gate.wait(); throw URLError(.timedOut) }
            return try http.defaultResponse(call)
        }
        let file = ChatAttachment(name: "photo.png", data: Data([1]), mediaType: "image/png", previewData: Data([2]))
        session.draft = "Look"; session.composer.attachments = [file]; session.draftAttachmentIDs = ["file_uploaded"]
        let send = Task { await session.sendDraft() }
        try await eventually { http.count("messages") == 1 }
        #expect(session.draft.isEmpty && session.composer.attachments.isEmpty)
        #expect(session.pendingMessages.first?.attachments.first?.previewData == Data([2]))
        gate.release(); _ = await send.value
        #expect(session.draft == "Look" && session.composer.attachments == [file])
        #expect(http.count("messages") == 1)
    }

    @Test func echoCannotEraseANewDraftEvenWhenItsTextMatchesTheSentMessage() async throws {
        let http = TestHTTPTransport(), realtime = TestRealtimeAPI(), gate = TestGate()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let session = repo.session(id: "session"), connection = Task { await repo.session(id: "session").connect() }
        defer { connection.cancel() }
        try await eventually { session.canSend }
        http.respond = { call in if call.path.hasSuffix("messages") { await gate.wait() }; return try http.defaultResponse(call) }
        session.draft = "Same text"
        let send = Task { await session.sendDraft() }
        try await eventually { http.count("messages") == 1 }
        let pending = try #require(session.pendingMessages.first)
        session.draft = "Same text"
        realtime.yield(try event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "echo", order: 2, seq: 11, clientID: pending.id)]))
        try await eventually { pending.delivery == .confirmed }
        gate.release(); _ = await send.value
        #expect(session.draft == "Same text")
    }
}
