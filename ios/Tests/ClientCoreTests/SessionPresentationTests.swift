import Foundation
import Observation
import Synchronization
import Testing
@testable import ClientCore

@Suite struct SessionPresentationTests {
    private func item(_ type: String = "tool", id: String = "item", status: String = "done", content: [String: Any], source: [String: Any] = [:]) throws -> V2TimelineItem {
        var value = try itemObject(id: id)
        value["type"] = type; value["status"] = status; value["content"] = content; value["source"] = source
        return try decode(value)
    }

    @Test func toolsParseCommandsMcpAndAgentActionsLikeWeb() throws {
        let command = try item(content: ["kind": "command", "input": ["cmd": ["rg", "needle", "src"]], "outputPreview": "src/main.swift:4"])
        let view = TimelineEntryPresentation(item: command, cwd: "/work")
        #expect(view.command == "rg needle src" && view.title == "执行 rg needle src")
        #expect(view.output == "src/main.swift:4" && view.input == nil)
        let mcp = TimelineEntryPresentation(item: try item(content: ["kind": "mcp", "input": ["server": "docs", "tool": "search", "query": "SwiftUI"]]), cwd: nil)
        #expect(mcp.title == "docs / search" && mcp.input != nil)
        let agent = TimelineEntryPresentation(item: try item(content: ["kind": "agent_call", "action": "spawn", "description": "Review changes"]), cwd: nil)
        #expect(agent.title == "创建 Agent：Review changes")
    }

    @Test @MainActor func tokenAndToolOutputUpdatesDoNotInvalidateListStructure() throws {
        let row = ChatTimelineRowModel(try item("message", status: "running", content: ["text": "a"]))
        let changed = ObservationFlag()
        withObservationTracking { _ = row.structure } onChange: { changed.set() }
        row.flush(try item("message", status: "running", content: ["text": "another token"]), animate: true, now: 1)
        #expect(!changed.isSet && row.text != "a")
        row.flush(try item("message", status: "done", content: ["text": "another token"]), animate: true, now: 2)
        #expect(changed.isSet && row.structure.status == .done)

        let tool = ChatTimelineRowModel(try item(status: "running", content: ["kind": "command", "command": "build", "output": "start"]))
        let regrouped = ObservationFlag()
        withObservationTracking { _ = TimelineGrouping.groups([tool], interactionTargets: []) } onChange: { regrouped.set() }
        tool.flush(try item(status: "running", content: ["kind": "command", "command": "build", "output": String(repeating: "log\n", count: 2000)]), animate: true, now: 3)
        #expect(!regrouped.isSet)
    }

    @Test func toolMarkerKeepsSummarySeparateFromDetailedOutputAndChanges() throws {
        let output = TimelineEntryPresentation(item: try item(content: ["kind": "command", "command": "build", "output": ["result": [1, 2, 3]]]), cwd: nil)
        #expect(output.title == "执行 build" && output.hasToolDetails)
        #expect(output.output?.contains("result") == true)
        let changes = TimelineEntryPresentation(item: try item(content: ["kind": "file_change", "changes": [
            ["path": "/work/new.swift", "kind": "add", "diff": "let value = 1"],
            ["path": "/work/old.swift", "kind": "delete", "diff": "old"]
        ], "output": "must not duplicate the diff"]), cwd: "/work")
        #expect(changes.title == "已修改文件" && changes.hasToolDetails)
        #expect(changes.output == nil && changes.changes.count == 2)
        #expect(changes.changes[1].diff == "-old")
    }

    @Test @MainActor func collapsingOneToolDoesNotInvalidateOtherMountedDetails() {
        let disclosures = TimelineDisclosureState()
        disclosures.toggle("first"); disclosures.toggle("second")
        let changed = ObservationFlag()
        withObservationTracking { _ = disclosures.isExpanded("second") } onChange: { changed.set() }
        disclosures.toggle("first")
        #expect(!disclosures.isExpanded("first") && disclosures.isExpanded("second"))
        #expect(!changed.isSet)
        disclosures.toggle("second")
        #expect(changed.isSet && !disclosures.isExpanded("second"))
    }

    @Test func fileArtifactsUseRealChangePayloadAndRelativePaths() throws {
        let value = try item("artifact", content: ["kind": "file_change", "changes": [
            ["filePath": "/work/src/app.swift", "kind": ["type": "add"], "diff": "let value = 1\n"]
        ]])
        let entry = TimelineEntryPresentation(item: value, cwd: "/work")
        #expect(entry.kind == .tool && entry.title == "已创建 src/app.swift")
        #expect(entry.changes.first?.diff == "+let value = 1\n+")
        #expect(TimelineText.displayPath("/workspace/a", cwd: "/work") == "/workspace/a")
        #expect(TimelineText.displayPath("C:\\repo\\src\\a.ts", cwd: "C:\\repo") == "src/a.ts")
        let deleted = TimelineFileChange(raw: .object(["path": .string("gone"), "status": .string("removed"), "patch": .string("old")]), index: 0, cwd: nil)
        #expect(deleted.action == .delete && deleted.diff == "-old")
    }

    @Test func diffLineNumbersDoNotCountMetadataOrNoNewlineMarkers() {
        let diff = TimelineDiff("--- a/x\n+++ b/x\n@@ -5,2 +8,2 @@\n old\n-before\n\\ No newline at end of file\n+after\n next")
        #expect(diff.lines[3].oldLine == 5 && diff.lines[3].newLine == 8)
        #expect(diff.lines[4].oldLine == 6 && diff.lines[4].newLine == nil)
        #expect(diff.lines[5].oldLine == nil && diff.lines[5].newLine == nil)
        #expect(diff.lines[6].oldLine == nil && diff.lines[6].newLine == 9)
        #expect(diff.lines[7].oldLine == 7 && diff.lines[7].newLine == 10)
    }

    @Test func reasoningAndVisibilityHonorWebSemanticsAndKeepRawExports() throws {
        let reasoning = try item("system", content: ["kind": "reasoning", "summaries": [["text": "First"], ["text": "Second"]], "rawText": "fallback"])
        #expect(reasoning.displayText == "First\n\nSecond" && reasoning.isReasoning)
        #expect(TimelineText.message("hello\n\n[Attached file: hidden]") == "hello")
        #expect(TimelineText.message("line\n") == "line\n")
        let hidden = try item("message", content: ["text": "No response requested."], source: ["runtime": "claude"])
        #expect(!hidden.isVisibleInChat)
        #expect(!(try item("artifact", content: ["kind": "diff"])).isVisibleInChat)
        let unknown = try item("vendor.new.kind", content: ["newField": 42])
        #expect(unknown.raw["type"] == .string("vendor.new.kind"))
        #expect(unknown.raw["content"]?["newField"] == .number(42))
    }

    @Test @MainActor func toolGroupsKeepFirstIdentityAndDoNotHideInteractions() throws {
        let first = ChatTimelineRowModel(try item(id: "a", content: ["kind": "command", "command": "ls"]))
        let second = ChatTimelineRowModel(try item(id: "b", content: ["kind": "mcp"]))
        let one = TimelineGrouping.groups([first], interactionTargets: [])
        let two = TimelineGrouping.groups([first, second], interactionTargets: [])
        #expect(one[0].id == two[0].id && two[0].kind == .tools)
        #expect(two[0].title == "2 次工具调用")
        let protected = TimelineGrouping.groups([first, second], interactionTargets: ["a"])
        #expect(protected.count == 2 && protected.allSatisfy { $0.kind == .single })
        let children = try ["x", "y"].map { ChatTimelineRowModel(try item(id: $0, content: ["kind": "agent_call", "parentItemId": "parent"])) }
        #expect(TimelineGrouping.groups(children, interactionTargets: [])[0].kind == .agents("parent"))
    }

    @Test func fileReferencesRouteDevicePathsWithoutOpeningLocalFilesOrWebLinks() throws {
        #expect(SessionFileReference.path(from: URL(string: "src/My%20File.swift:32:2")!) == "src/My File.swift")
        #expect(SessionFileReference.path(from: URL(string: "file:///work/app.swift#L8")!) == "/work/app.swift")
        #expect(SessionFileReference.path(from: URL(string: "C:/work/app.swift:8")!) == "C:/work/app.swift")
        #expect(SessionFileReference.path(from: URL(string: "https://example.test/file.md")!) == nil)
        #expect(SessionFileReference.path(from: URL(string: "javascript:alert(1)")!) == nil)
        #expect(SessionFileReference.path(from: URL(string: "//example.test/a.txt")!) == nil)
        let link = try #require(SessionFileReference.link("/work/a #1.swift"))
        #expect(SessionFileReference.path(from: link) == "/work/a #1.swift")
        #expect(SessionFileReference.inlinePath("src/a.ts:10") == "src/a.ts")
    }

    @Test @MainActor func workspacePreviewOnlyMintsScopedWebEntryToken() async throws {
        let transport = TestHTTPTransport()
        transport.respond = { call in
            #expect(call.path == "/connectors/device/fs/preview-token")
            #expect(call.body?["path"] == .string("src/a.md"))
            #expect(call.query.first(where: { $0.name == "root" })?.value == "/work")
            return Data(#"{"previewToken":"one-use","expiresAt":"later","serverTime":"now"}"#.utf8)
        }
        let service = V2WorkspaceFilesService(connectorAPI: V2ConnectorAPI(transport: transport), serverURL: URL(string: "https://example.test/api/v2")!)
        let url = try await service.previewURL(connectorId: "device", root: "/work", entry: .init(name: "a.md", path: "src/a.md", type: "file", size: nil, modifiedAt: nil))
        #expect(url.host == "example.test" && url.fragment?.hasPrefix("/preview?") == true)
        #expect(transport.calls.count == 1)
    }
}

nonisolated private final class ObservationFlag: Sendable {
    private let value = Mutex(false)
    var isSet: Bool { value.withLock { $0 } }
    func set() { value.withLock { $0 = true } }
}
