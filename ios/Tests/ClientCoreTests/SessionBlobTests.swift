import Foundation
import Testing
@testable import ClientCore

/// Attachment API stub for the blob chunk loop and the encrypted attachment fallback.
@MainActor private final class StubAttachmentAPI: V2AttachmentAPIProtocol {
    var encrypted = false
    var chunks: [(Int, Int) throws -> V2SessionBlobChunk] = []
    var reads: [(blobRef: String, offset: Int, length: Int)] = []
    var downloads: [String] = []

    func upload(sessionId: V2SessionID, files: [HTTPUploadFile]) async throws -> V2AttachmentUploadResponse {
        throw HTTPError.invalidResponse
    }
    func download(sessionId: V2SessionID, fileId: V2AttachmentID) async throws -> V2AttachmentDownload {
        downloads.append(fileId)
        return V2AttachmentDownload(fileId: fileId, sessionId: sessionId, path: "", name: "a.txt", size: 2, sha256: "",
                                    contentBase64: Data("hi".utf8).base64EncodedString(), createdAt: "", serverTime: "")
    }
    func readBlobChunk(sessionId: V2SessionID, blobRef: String, offset: Int, length: Int) async throws -> V2SessionBlobChunk {
        reads.append((blobRef, offset, length))
        guard !chunks.isEmpty else { throw HTTPError.invalidResponse }
        return try chunks.removeFirst()(offset, length)
    }
    func usesSecureChannel(sessionId: V2SessionID) async throws -> Bool { encrypted }
}

private func chunk(_ bytes: String, offset: Int, size: Int, eof: Bool, encoding: String = "base64") -> V2SessionBlobChunk {
    V2SessionBlobChunk(blobRef: "blob_x", name: "output", mediaType: "text/plain; charset=utf-8", encoding: encoding,
                       data: Data(bytes.utf8).base64EncodedString(), offset: offset, size: size, eof: eof)
}

private func timelineItem(type: String = "tool", role: String? = nil, content: [String: Any], blobRefs: Any? = nil,
                          source: [String: Any] = [:]) throws -> V2TimelineItem {
    var object = try itemObject()
    object["type"] = type
    object["role"] = role ?? NSNull()
    object["content"] = content
    object["source"] = source
    if let blobRefs { object["blobRefs"] = blobRefs }
    return try decode(object)
}

@MainActor struct SessionBlobTests {
    // MARK: Decoding

    @Test func itemsWithoutBlobRefsStillDecode() throws {
        let item = try timelineItem(content: ["output": "done"])
        #expect(item.blobRefs.isEmpty)
        #expect(try timelineItem(content: [:], blobRefs: NSNull()).blobRefs.isEmpty)
    }

    @Test func blobRefsDecodeAndDropMalformedEntries() throws {
        let item = try timelineItem(content: ["output": "head…tail"], blobRefs: [
            ["path": "/output", "blobId": "blob_" + String(repeating: "a", count: 64), "bytes": 81920, "mediaType": "text/plain; charset=utf-8"],
            ["path": "/content/0/data", "blobId": "blob_b", "bytes": 120, "mediaType": NSNull()],
            ["path": "output", "blobId": "blob_c", "bytes": 1, "mediaType": "text/plain"],
            ["path": "/x", "blobId": "", "bytes": 1],
            ["path": "/x", "blobId": "blob_d", "bytes": -1],
            ["path": "/x", "blobId": "blob_e", "bytes": 1.5],
        ])
        #expect(item.blobRefs.map(\.blobId) == ["blob_" + String(repeating: "a", count: 64), "blob_b"])
        #expect(item.blobRefs[0].bytes == 81920)
        #expect(item.blobRefs[0].mediaType == "text/plain; charset=utf-8")
        #expect(item.blobRefs[1].mediaType == nil)
    }

    // MARK: JSON pointer

    @Test func jsonPointerFollowsRFC6901() {
        #expect(JSONPointer.tokens("") == [])
        #expect(JSONPointer.tokens("/a~1b/m~0n/") == ["a/b", "m~n", ""])
        #expect(JSONPointer.tokens("a") == nil)
        #expect(JSONPointer.tokens("/a~2") == nil)
        #expect(JSONPointer.tokens("/a~") == nil)
        let tree: JSONValue = .object([
            "content": .array([.object(["type": .string("image"), "data": .string("x")])]),
            "a/b": .number(1), "rawOutput": .object(["stdout": .string("out")]),
        ])
        #expect(JSONPointer.resolve("/content/0/type", in: tree) == .string("image"))
        #expect(JSONPointer.resolve("/a~1b", in: tree) == .number(1))
        #expect(JSONPointer.resolve("/rawOutput/stdout", in: tree) == .string("out"))
        #expect(JSONPointer.resolve("/content/01/type", in: tree) == nil)
        #expect(JSONPointer.resolve("/content/1", in: tree) == nil)
        #expect(JSONPointer.resolve("/content/-", in: tree) == nil)
        #expect(JSONPointer.resolve("", in: tree) == tree)
    }

    @Test func refsDescribeTheirFieldFromTheContent() throws {
        let item = try timelineItem(content: [
            "output": "head…（中间省略 12 KB，完整内容 80 KB，可展开查看）…tail",
            "content": [["type": "image", "mimeType": "image/png", "omitted": "图片，约 120 KB，已存到本机"]],
            "rawInput": ["url": "[image/png，120 KB，已存到本机，可展开查看]"],
            "rawOutput": ["blob": ["type": "audio", "omitted": "音频"]],
        ], blobRefs: [
            ["path": "/output", "blobId": "blob_t", "bytes": 81920, "mediaType": "text/plain; charset=utf-8"],
            ["path": "/content/0/data", "blobId": "blob_i", "bytes": 122880, "mediaType": NSNull()],
            ["path": "/rawInput/url", "blobId": "blob_u", "bytes": 122880, "mediaType": "image/png"],
            ["path": "/rawOutput/blob/data", "blobId": "blob_a", "bytes": 10, "mediaType": "application/octet-stream"],
            ["path": "/rawOutput/bin", "blobId": "blob_o", "bytes": 10, "mediaType": "application/zip"],
        ])
        let content = item.contentTree
        let refs = item.blobRefs
        #expect(refs.map { $0.kind(in: content) } == [.text, .image, .image, .audio, .other])
        #expect(refs[0].placeholder(in: content) == nil)
        #expect(refs[0].label(in: content) == "output")
        #expect(refs[0].suggestedFileName(in: content) == "output.txt")
        #expect(refs[1].effectiveMediaType(in: content) == "image/png")
        #expect(refs[1].placeholder(in: content) == "图片，约 120 KB，已存到本机")
        #expect(refs[1].label(in: content) == "image")
        #expect(refs[1].suggestedFileName(in: content) == "image.png")
        #expect(refs[2].placeholder(in: content) == "[image/png，120 KB，已存到本机，可展开查看]")
        #expect(refs[2].label(in: content) == "url")
        #expect(refs[4].suggestedFileName(in: content) == "bin.zip")
        let attachment = refs[1].attachment(in: content)
        #expect(attachment.isTimelineBlob && attachment.fileId == "blob_i" && attachment.isImage && !attachment.readsFromDevice)
    }

    @Test func toolOutputPointerNamesThePreviewField() throws {
        let item = try timelineItem(content: ["kind": "command", "command": "ls", "output": "preview"],
                                    blobRefs: [["path": "/output", "blobId": "blob_t", "bytes": 9, "mediaType": "text/plain"]])
        #expect(TimelineEntryPresentation(item: item, cwd: nil).outputPointer == "/output")
        let error = try timelineItem(content: ["kind": "command", "error": "boom"])
        #expect(TimelineEntryPresentation(item: error, cwd: nil).outputPointer == "/error")
    }

    // MARK: Chunk loop

    @Test func blobReadsLoopUntilEOFOverTheSessionRoute() async throws {
        let transport = TestHTTPTransport()
        let parts = ["hello ", "world"]
        transport.respond = { call in
            let offset = Int(call.query.first { $0.name == "offset" }?.value ?? "") ?? -1
            let index = offset == 0 ? 0 : 1
            let value: [String: Any] = ["blobRef": "blob_x", "name": "output", "mediaType": "text/plain; charset=utf-8",
                "encoding": "base64", "data": Data(parts[index].utf8).base64EncodedString(), "offset": offset,
                "size": 11, "eof": index == 1]
            return try JSONSerialization.data(withJSONObject: value)
        }
        let service = V2AttachmentService(attachmentAPI: V2AttachmentAPI(transport: transport))
        let blob = try await service.readSessionBlob(sessionId: "s 1", blobRef: "blob_x", maxBytes: 1024)
        #expect(String(decoding: blob.data, as: UTF8.self) == "hello world")
        #expect(blob.name == "output" && blob.mediaType == "text/plain; charset=utf-8")
        #expect(transport.calls.map(\.path) == ["/sessions/s%201/blobs/blob_x", "/sessions/s%201/blobs/blob_x"])
        #expect(transport.calls.map { $0.query.first { $0.name == "offset" }?.value } == ["0", "6"])
        #expect(transport.calls.allSatisfy { $0.method == .get && $0.query.contains(URLQueryItem(name: "length", value: "4194304")) })
    }

    @Test func blobContentIsRoutedLikeOtherSessionContent() {
        #expect(E2EEContentTarget.classify(method: .get, path: "/sessions/s1/blobs/blob_x?offset=0&length=4") == .session("s1"))
        #expect(E2EEContentTarget.classify(method: .get, path: "/sessions/s1/blobs/file_1") == .session("s1"))
    }

    @Test func blobReadRejectsInconsistentChunks() async throws {
        let api = StubAttachmentAPI()
        let service = V2AttachmentService(attachmentAPI: api)
        func expectFailure(_ chunks: [(Int, Int) throws -> V2SessionBlobChunk], max: Int = 1024,
                           _ matches: (Error) -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async {
            api.chunks = chunks
            do {
                _ = try await service.readSessionBlob(sessionId: "s", blobRef: "blob_x", maxBytes: max)
                Issue.record("Expected a failure", sourceLocation: sourceLocation)
            } catch { #expect(matches(error), "\(error)", sourceLocation: sourceLocation) }
        }
        func incomplete(_ error: Error) -> Bool { if case V2BusinessError.blobIncomplete = error { true } else { false } }
        func malformed(_ error: Error) -> Bool { if case V2BusinessError.blobMalformed = error { true } else { false } }
        // eof before all bytes arrived
        await expectFailure([{ _, _ in chunk("abc", offset: 0, size: 5, eof: true) }], incomplete)
        // empty chunk that is not the end
        await expectFailure([{ _, _ in chunk("ab", offset: 0, size: 5, eof: false) }, { _, _ in chunk("", offset: 2, size: 5, eof: false) }], incomplete)
        // chunk for another offset
        await expectFailure([{ _, _ in chunk("ab", offset: 0, size: 4, eof: false) }, { _, _ in chunk("cd", offset: 1, size: 4, eof: true) }], malformed)
        // more bytes than the declared size
        await expectFailure([{ _, _ in chunk("abcdef", offset: 0, size: 4, eof: true) }], malformed)
        // size changing between chunks
        await expectFailure([{ _, _ in chunk("ab", offset: 0, size: 4, eof: false) }, { _, _ in chunk("cd", offset: 2, size: 5, eof: false) }], malformed)
        // unknown encoding
        await expectFailure([{ _, _ in chunk("ab", offset: 0, size: 2, eof: true, encoding: "utf-8") }], malformed)
        // too large: refused after the first chunk, no further reads
        api.reads = []
        await expectFailure([{ _, _ in chunk("ab", offset: 0, size: 2048, eof: false) }], max: 1024) {
            if case let V2BusinessError.blobTooLarge(size, limit) = $0 { size == 2048 && limit == 1024 } else { false }
        }
        #expect(api.reads.count == 1)
        // device errors pass through
        await expectFailure([{ _, _ in throw HTTPError.server(statusCode: 404, message: "missing", detail: .object(["code": .string("blob_not_found")])) }]) {
            ($0 as? HTTPError)?.serverCode == "blob_not_found"
        }
        // an empty blob completes on its first chunk
        api.chunks = [{ _, _ in chunk("", offset: 0, size: 0, eof: true) }]
        #expect(try await service.readSessionBlob(sessionId: "s", blobRef: "blob_x", maxBytes: 1).data.isEmpty)
    }

    @Test func blobErrorsReadAsUserText() {
        let missing = HTTPError.server(statusCode: 404, message: "x", detail: .object(["code": .string("blob_not_found")]))
        #expect(SessionBlobErrorText.text(missing) == String(localized: "设备上已找不到这份内容。"))
        let offline = HTTPError.server(statusCode: 409, message: "x", detail: .object(["code": .string("connector_offline")]))
        #expect(SessionBlobErrorText.text(offline) == String(localized: "设备离线，暂时无法读取完整内容。"))
        #expect(SessionBlobErrorText.text(HTTPError.server(statusCode: 404, message: "Not Found")).contains("Agents Anywhere"))
    }

    // MARK: Attachments

    @Test func attachmentsUseTheServerRouteInPlainMode() async throws {
        let api = StubAttachmentAPI()
        let data = try await V2AttachmentService(attachmentAPI: api).download(sessionId: "s", fileId: "file_1")
        #expect(data == Data("hi".utf8))
        #expect(api.downloads == ["file_1"] && api.reads.isEmpty)
    }

    @Test func encryptedAttachmentsAreReadFromTheDeviceBlobRoute() async throws {
        let api = StubAttachmentAPI()
        api.encrypted = true
        api.chunks = [{ _, _ in chunk("png", offset: 0, size: 3, eof: true) }]
        let data = try await V2AttachmentService(attachmentAPI: api).download(sessionId: "s", fileId: "file_1")
        #expect(data == Data("png".utf8))
        #expect(api.downloads.isEmpty)
        #expect(api.reads.map(\.blobRef) == ["file_1"])
    }

    @Test func userMessageAttachmentsRenderForEveryRuntime() throws {
        for runtime in ["codex", "claude", "dsh", "acp"] {
            let item = try timelineItem(type: "message", role: "user", content: [
                "text": "look",
                "attachments": [
                    ["fileId": "file_img", "name": "shot.png", "mediaType": "image/png", "size": 2048, "sha256": "abc"],
                    ["fileId": "file_doc", "name": "notes.pdf", "mediaType": "application/pdf"],
                ],
            ], source: ["runtime": runtime, "clientMessageId": "c1"])
            guard case let .message(message) = item.content else { Issue.record("not a message"); continue }
            #expect(message.attachments.map(\.fileId) == ["file_img", "file_doc"])
            #expect(message.attachments.map(\.isImage) == [true, false])
            #expect(message.attachments.allSatisfy { !$0.readsFromDevice && !$0.isTimelineBlob })
            let resolved = ChatAttachmentStore().resolve(message.attachments, clientID: "c1")
            #expect(resolved.map(\.id) == ["file_img", "file_doc"])
            #expect(resolved[0].content.size == 2048 && resolved[1].content.size == nil)
        }
    }

    // MARK: Store

    @Test func storeLoadsTextOnceAndReportsFailures() async throws {
        var calls: [(String, Int)] = []
        var fail = false
        let store = SessionBlobStore { ref, limit in
            calls.append((ref, limit))
            if fail { throw HTTPError.server(statusCode: 404, message: "x", detail: .object(["code": .string("blob_not_found")])) }
            return V2SessionBlob(blobRef: ref, name: nil, mediaType: "text/plain", data: Data("full text".utf8))
        }
        let item = try timelineItem(content: ["output": "pre…"],
                                    blobRefs: [["path": "/output", "blobId": "blob_t", "bytes": 9, "mediaType": "text/plain"]])
        let ref = item.blobRefs[0]
        store.load(ref, kind: .text)
        #expect(store.state("blob_t") == .loading)
        try await eventually { store.state("blob_t") == .text("full text") }
        store.load(ref, kind: .text)
        #expect(calls.count == 1 && calls[0].1 == SessionBlobStore.inlineTextLimit)
        #expect(store.loadedText(for: item, at: "/output") == "full text")
        #expect(store.loadedText(for: item, at: "/other") == nil)

        fail = true
        let other = V2TimelineBlobRef(path: "/content/0/data", blobId: "blob_i", bytes: 10, mediaType: "image/png")
        store.load(other, kind: .image)
        try await eventually { if case .failed = store.state("blob_i") { true } else { false } }
        #expect(store.state("blob_i") == .failed(String(localized: "设备上已找不到这份内容。")))
        #expect(calls.last?.1 == SessionBlobStore.inlineImageLimit)
    }

    @Test func storeOnlyInlinesSmallTextAndImages() {
        let large = V2TimelineBlobRef(path: "/output", blobId: "b", bytes: SessionBlobStore.inlineTextLimit + 1, mediaType: "text/plain")
        let small = V2TimelineBlobRef(path: "/output", blobId: "b", bytes: 10, mediaType: "text/plain")
        #expect(!SessionBlobStore.showsInline(large, kind: .text))
        #expect(SessionBlobStore.showsInline(small, kind: .text))
        #expect(SessionBlobStore.showsInline(small, kind: .image))
        #expect(!SessionBlobStore.showsInline(small, kind: .audio))
        #expect(!SessionBlobStore.showsInline(small, kind: .other))
        var loads = 0
        let store = SessionBlobStore { _, _ in loads += 1; throw HTTPError.invalidResponse }
        store.load(large, kind: .text)
        #expect(store.state("b") == .idle && loads == 0)
    }
}
