import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionEnrichmentTests {
    private func enriched(_ text: String) throws -> AttributedString {
        GitDirectiveParser.enrich(try AttributedString(markdown: text)) { values, attributes in
            AttributedString("[" + values.map { $0.action.rawValue }.joined(separator: " · ") + "]", attributes: attributes)
        }
    }

    @Test func gitDirectivesMergeOnlyAdjacentCompleteOperations() throws {
        let text = #"::git-stage{} ::git-commit{} ::git-create-branch{branch="fix/中文"} ::git-push{branch="v2"} ::git-create-pr{url="https://example.test/pr/1" isDraft="true"}"#
        let match = try #require(GitDirectiveParser.matches(in: text).first)
        #expect(match.directives.map(\.action) == [.stage, .commit, .createBranch, .push, .createPR])
        #expect(match.directives[2].attributes["branch"] == "fix/中文")
        #expect(match.directives.last?.url?.host == "example.test")
        #expect(GitDirectiveParser.matches(in: "::git-commit{} then ::git-push{}").count == 2)
        #expect(GitDirectiveParser.matches(in: "::git-delete{} ::git-push{branch=\"unfinished").isEmpty)
        let unsafe = try #require(GitDirectiveParser.matches(in: #"::git-create-pr{url="javascript:alert(1)"}"#).first)
        #expect(unsafe.directives.first?.url == nil)
        let escaped = try #require(GitDirectiveParser.matches(in: #"::git-create-branch{branch="quoted\"name"}"#).first)
        #expect(escaped.directives.first?.attributes["branch"] == "quoted\"name")
    }

    @Test func markdownCodeAndLinksRemainLiteralAndBlockIdentitiesSurvive() throws {
        let source = "Paragraph.\n\n`::git-commit{}`\n\n```text\n::git-push{}\n```\n\n- ::git-stage{}\n- Item\n\n> ::git-commit{}"
        let original = try AttributedString(markdown: source)
        let value = try enriched(source)
        let plain = String(value.characters)
        #expect(plain.contains("::git-commit{}") && plain.contains("::git-push{}"))
        #expect(plain.contains("[stage]") && plain.contains("[commit]"))
        #expect(MarkdownBlockSnapshot.split(original).map(\.id) == MarkdownBlockSnapshot.split(value).map(\.id))
        let linked = try enriched("[src/main.swift](https://example.test/a)\n\n[::git-commit{}](https://example.test/pr)")
        #expect(linked.runs.filter { $0.link != nil }.count == 2)
    }

    @Test func streamingTailPreservesCompletedMarkdownBlocks() throws {
        let prefix = "# Stable\n\nA **finished** paragraph.\n\n"
        let expected = MarkdownBlockSnapshot.split(try enriched(prefix))
        let tail = "Working ::git-commit{} ::git-push{branch=\"v2\"}"
        for end in 1...tail.count {
            let blocks = MarkdownBlockSnapshot.split(try enriched(prefix + tail.prefix(end)))
            #expect(Array(blocks.prefix(expected.count)) == expected)
        }
    }

    @Test func referencesKeepLocationAndRejectCodeThatIsNotAPath() throws {
        for (input, path, line, column) in [
            ("src/main.swift:42:8", "src/main.swift", 42, 8),
            (#"C:\work\My File.swift:10:3"#, #"C:\work\My File.swift"#, 10, 3),
            ("./My File.swift#L22C2", "./My File.swift", 22, 2),
        ] {
            let reference = try #require(SessionFileReference.inlineReference(input))
            #expect(reference.path == path && reference.line == line && reference.column == column)
            #expect(SessionFileReference.reference(from: try #require(reference.link)) == reference)
        }
        for input in ["README.md", "Dockerfile", "package.json", ".gitignore", "~/repo/LICENSE", "./bin/tool", #"src\main.swift"#] {
            #expect(SessionFileReference.inlineReference(input) != nil)
        }
        for input in [".soft", ".init", "1.2.3", "git status", "cat src/a.swift", "https://example.test/a.md", "//example.test/a.md"] {
            #expect(SessionFileReference.inlineReference(input) == nil)
        }
        #expect(SessionFileReference.reference(from: URL(string: "README.md:42")!) == .init(path: "README.md", line: 42))
        #expect(SessionFileReference.inlineReference(#".\My File.swift:4"#)?.path == #".\My File.swift"#)
        let file = try #require(SessionFileReference.reference(from: URL(string: "file:///work/My%20File.swift#L8C3")!))
        #expect(file.path == "/work/My File.swift" && file.line == 8 && file.column == 3)
        #expect(SessionFileReference.reference(from: URL(string: "https://example.test/main.swift#L8")!) == nil)
        #expect(SessionFileReference.reference(from: URL(string: "file:///work/a%2520b.swift")!)?.path == "/work/a%20b.swift")
    }

    private func item(_ id: String, order: Int, content: [String: Any], revision: Int = 1, seq: Int = 1) throws -> V2TimelineItem {
        var object = try itemObject(id: id, order: order, revision: revision, seq: seq)
        object["type"] = "artifact"; object["content"] = content
        return try decode(object)
    }

    @Test func reviewDeduplicatesRevisionsAndRetainsSeparatePatches() throws {
        let old = try item("change", order: 2, content: ["kind": "file_change", "changes": [["path": "src/a.swift", "action": "modify", "diff": "@@\n+old"]]])
        let new = try item("change", order: 2, content: ["kind": "file_change", "changes": [["path": "src/a.swift", "action": "update", "diff": "--- a\n+++ b\n@@\n-before\n+after\n+two"]]], revision: 2, seq: 2)
        let other = try item("second", order: 3, content: ["kind": "file_change", "path": "/repo/src/a.swift", "action": "modify", "patch": "@@\n+three"])
        let review = TimelineTurnReview.build(items: [new, old, other], root: "/repo")
        #expect(review.files.count == 1)
        #expect(review.files[0].displayPath == "src/a.swift" && review.files[0].patches.count == 2)
        #expect(review.additions == 3 && review.deletions == 1)
        #expect(review.files[0].action == .modify)
    }

    @Test func reviewNormalizesMapPayloadWindowsPathsAndRawNewFiles() throws {
        let a = try item("a", order: 1, content: ["kind": "file_change", "changes": [#"C:\Repo\new.txt"#: ["action": "add", "content": "first\r\nsecond\r\n"]]])
        let b = try item("b", order: 2, content: ["kind": "file_change", "changes": [["path": "c:/repo/NEW.txt", "action": "modify", "diff": "@@\n-third\n+fourth"]]])
        let review = TimelineTurnReview.build(items: [a, b], root: "C:/Repo", caseInsensitive: true)
        #expect(review.files.count == 1 && review.files[0].action == .add)
        #expect(review.additions == 3 && review.deletions == 1)
        #expect(review.files[0].patches.first?.text == "+first\n+second")
        let deleted = try item("delete", order: 3, content: ["kind": "file_change", "path": "C:/Repo/new.txt", "action": "delete"])
        #expect(TimelineTurnReview.build(items: [a, b, deleted], root: "C:/Repo", caseInsensitive: true).files.isEmpty)
    }

    @Test func toolOnlyTurnsGetACompletedReviewFooterAndStreamingDoesNot() throws {
        let change = ChatTimelineRowModel(try item("change", order: 1, content: ["kind": "file_change", "path": "a.swift", "action": "add", "diff": "a"] ))
        let groups = TimelineGrouping.groups([change], interactionTargets: [])
        #expect(TimelineTurnActions.build(groups: groups, suppressLatest: true).isEmpty)
        let action = try #require(TimelineTurnActions.build(groups: groups, suppressLatest: false)["change"])
        #expect(action.replies.isEmpty && action.changes.map(\.id) == ["change"] && action.startsMidTurn)
    }

    @Test func steeringMessagesStayInOneTurnAndNextTurnSeparatesChanges() throws {
        func message(_ id: String, steering: Bool = false) throws -> ChatTimelineRowModel {
            var object = try itemObject(id: id)
            object["role"] = "user"
            object["source"] = ["itemType": steering ? "steeringUserMessage" : "userMessage"]
            return ChatTimelineRowModel(try decode(object))
        }
        let change = ChatTimelineRowModel(try item("change", order: 2, content: ["kind": "file_change", "path": "a.swift", "action": "add"]))
        let groups = TimelineGrouping.groups(try [message("first"), change, message("steer", steering: true), message("next")], interactionTargets: [])
        let actions = TimelineTurnActions.build(groups: groups, suppressLatest: true)
        #expect(actions.count == 1 && actions["steer"]?.changes.map(\.id) == ["change"])
        #expect(actions["steer"]?.startsMidTurn == false)
    }

    @Test func previewLocationStaysOutOfConnectorReadRequest() async throws {
        let transport = TestHTTPTransport()
        transport.respond = { call in
            #expect(call.body?["path"] == .string("src/a.swift"))
            #expect(call.body?["line"] == nil && call.body?["column"] == nil)
            return Data(#"{"previewToken":"one-use","expiresAt":"later","serverTime":"now"}"#.utf8)
        }
        let service = V2WorkspaceFilesService(connectorAPI: V2ConnectorAPI(transport: transport), serverURL: URL(string: "https://example.test/api/v2")!)
        let url = try await service.previewURL(connectorId: "device", root: "/repo", entry: .init(name: "a.swift", path: "src/a.swift", type: "file", size: nil, modifiedAt: nil), location: .init(path: "src/a.swift", line: 42, column: 8))
        var fragment = URLComponents(); fragment.percentEncodedQuery = String(try #require(url.fragment).dropFirst("/preview?".count))
        #expect(fragment.queryItems?.first(where: { $0.name == "line" })?.value == "42")
        #expect(fragment.queryItems?.first(where: { $0.name == "column" })?.value == "8")
        #expect(transport.calls.count == 1)
    }
}
