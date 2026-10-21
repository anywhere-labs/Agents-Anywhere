import Foundation
import Testing
@testable import ClientCore

@Suite struct MarkdownStreamSplitTests {
    private func prefix(_ text: String) -> String? {
        MarkdownStreamSplit.safeSplitIndex(in: text).map { String(text[..<$0]) }
    }

    @Test func paragraphsSplitAtTheLastBlankLineBeforeAnOpenParagraph() {
        #expect(prefix("First.\n\nSecond.\n\nThird is still") == "First.\n\nSecond.\n\n")
        #expect(prefix("Only one paragraph that is still streaming") == nil)
        // Trailing blank lines do not tell whether a list continues; wait for more text.
        #expect(prefix("Done.\n\n") == nil)
    }

    @Test func fencedCodeIsNeverSplitWhileOpen() {
        let open = "Intro.\n\n```swift\nlet a = 1\n\nlet b = 2\n"
        #expect(prefix(open) == nil)
        let closed = open + "```\n\nAfter."
        #expect(prefix(closed) == "Intro.\n\n```swift\nlet a = 1\n\nlet b = 2\n```\n\n")
        #expect(prefix("~~~\ntext\n\n~~~\n\nNext") == "~~~\ntext\n\n~~~\n\n")
    }

    @Test func looseListsAndIndentedContinuationsStayTogether() {
        let list = "Steps:\n\n- one\n\n- two\n\n  detail\n\n3. three\n\n2) four"
        #expect(prefix(list) == "Steps:\n\n")
        let afterList = list + "\n\nPlain paragraph"
        #expect(prefix(afterList) == list + "\n\n")
        #expect(prefix("Text.\n\n    code block") == "Text.\n\n")
        #expect(prefix("- a\n\n    nested code") == nil)
    }

    @Test func parseStateCoversOnlyTextThatExtendsItsPrefix() {
        var state = MarkdownParseState()
        state.prefixText = "Hello.\n\n"
        #expect(state.covers("Hello.\n\nWorld"))
        #expect(!state.covers("Hallo.\n\nWorld"))
        #expect(!state.covers("Hi"))
        let text = "Hello.\n\n世界"
        #expect(text[state.prefixEnd(text)...] == "世界")
    }
}
