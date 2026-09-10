import Foundation
import Testing
@testable import Textual

@Suite @MainActor
struct MarkdownComponentContentTests {
    @Test func codeCopyUsesOnlyLiteralCodeWithWhitespaceAndUnicode() throws {
        let document = try parse("Before\n\n```swift\nlet answer = \"🙂\"\n\n  print(answer)\n```\n\nAfter")
        let run = try #require(document.blockRuns().first { run in
            if case .codeBlock = run.intent?.kind { return true }
            return false
        })
        let proxy = StructuredText.CodeBlockProxy(document[run.range])
        #expect(proxy.text == "let answer = \"🙂\"\n\n  print(answer)\n")
        let empty = AttributedString()
        #expect(StructuredText.CodeBlockProxy(empty[empty.startIndex..<empty.endIndex]).text.isEmpty)
    }

    @Test func tableKeepsEmptyCellsInTheirOriginalColumns() throws {
        let table = try firstTable(in: parse("""
        | A | B | C |
        | :--- | :---: | ---: |
        | | middle | |
        | left | | right |
        """))
        #expect(table.rows.map { $0.map { String($0.characters) } } == [
            ["A", "B", "C"], ["", "middle", ""], ["left", "", "right"],
        ])
        #expect(table.columns.map(\.alignment) == [.left, .center, .right])
    }

    @Test func tableCellsKeepFormattingAndInteractiveLinkDestinations() throws {
        let table = try firstTable(in: parse("""
        | Kind | Value |
        | --- | --- |
        | **Bold** | [Documentation](https://example.com/docs) |
        | `code` | ![Diagram](https://example.com/diagram.png) |
        """))
        #expect(table.rows[1][0].runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(table.rows[1][1].runs.contains { $0.link == URL(string: "https://example.com/docs") })
        #expect(table.rows[2][0].runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        #expect(table.rows[2][1].runs.contains { $0.imageURL == URL(string: "https://example.com/diagram.png") })
    }

    @Test func tableInsideBlockQuoteDoesNotIncludeSurroundingParagraphs() throws {
        let document = try parse("""
        Before

        > Intro
        >
        > | A | B |
        > | --- | --- |
        > | first | second |
        >
        > End

        After
        """)
        let table = try firstTable(in: document)
        #expect(table.rows.map { $0.map { String($0.characters) } } == [["A", "B"], ["first", "second"]])
    }

    private func parse(_ source: String) throws -> AttributedString {
        try AttributedStringMarkdownParser(baseURL: nil).attributedString(for: source)
    }

    private func firstTable(in document: AttributedString) throws -> (rows: [[AttributedString]], columns: [PresentationIntent.TableColumn]) {
        func find(in content: AttributedSubstring, parent: PresentationIntent.IntentType? = nil)
            -> (rows: [[AttributedString]], columns: [PresentationIntent.TableColumn])? {
            for block in content.blockRuns(parent: parent) {
                if case .table(let columns) = block.intent?.kind {
                    return (StructuredText.TableContent(content: content[block.range], intent: block.intent,
                        columnCount: columns.count).rows, columns)
                }
                if let intent = block.intent,
                   let result = find(in: content[block.range], parent: intent) { return result }
            }
            return nil
        }
        return try #require(find(in: document[document.startIndex..<document.endIndex]))
    }
}
